import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSmokeFixtures } from '../src/services/smokeFixtures.js';
import { SwePlanSchema } from '../src/schemas/agentContracts.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function pickProjectRoot(): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const workspaceRoot = resolve(repoRoot, '..');
  const candidates = [
    join(workspaceRoot, 'Example Finance Forecast-app'),
    join(workspaceRoot, 'Example-Mobile-Finance'),
    join(workspaceRoot, 'private source repo'),
    repoRoot,
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('No usable project root found for smoke fixture testing.');
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function parseJsonOutput(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`${label}: expected JSON stdout, got ${JSON.stringify(stdout)} (${String(err)})`);
  }
}

async function assertCheckpointRestoreSmoke(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(scriptDir, '..');
  const base = mkdtempSync(join(tmpdir(), 'babel-checkpoint-smoke-'));
  const projectRoot = join(base, 'project');
  const babelRoot = join(base, 'private source repo');
  const runsDir = join(babelRoot, 'runs');
  const runId = '20260424_120000_checkpoint-smoke';
  const runDir = join(runsDir, runId);
  const targetPath = join(projectRoot, 'src', 'recover.txt');

  const previousEnv = {
    BABEL_ALLOWED_ROOTS: process.env['BABEL_ALLOWED_ROOTS'],
    BABEL_DRY_RUN: process.env['BABEL_DRY_RUN'],
    BABEL_DRY_RUN_SOURCE: process.env['BABEL_DRY_RUN_SOURCE'],
    BABEL_ENV: process.env['BABEL_ENV'],
    BABEL_PROJECT_ROOT: process.env['BABEL_PROJECT_ROOT'],
    BABEL_ROOT: process.env['BABEL_ROOT'],
    BABEL_RUNS_DIR: process.env['BABEL_RUNS_DIR'],
    BABEL_SHADOW_ROOT: process.env['BABEL_SHADOW_ROOT'],
  };

  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(targetPath, 'before\n', 'utf-8');
    writeFileSync(
      join(projectRoot, 'mutate.js'),
      "const fs = require('node:fs');\nfs.writeFileSync('src/recover.txt', 'shell-after\\n', 'utf-8');\n",
      'utf-8',
    );

    process.env['BABEL_ALLOWED_ROOTS'] = base;
    process.env['BABEL_DRY_RUN'] = 'false';
    process.env['BABEL_DRY_RUN_SOURCE'] = 'session';
    process.env['BABEL_ENV'] = 'test';
    process.env['BABEL_PROJECT_ROOT'] = projectRoot;
    process.env['BABEL_ROOT'] = babelRoot;
    process.env['BABEL_RUNS_DIR'] = runsDir;
    delete process.env['BABEL_SHADOW_ROOT'];

    const { executeTool } = await import('../src/localTools.js');
    const writeResult = await executeTool({
      tool: 'file_write',
      path: 'src/recover.txt',
      content: 'after\n',
    }, {
      agentId: 'checkpoint-smoke',
      runId,
      runDir,
      babelRoot,
    });

    assert(writeResult.exit_code === 0, `checkpoint smoke: file_write failed: ${writeResult.stderr}`);
    assert(writeResult.checkpoint_ids?.length === 1, 'checkpoint smoke: file_write did not return one checkpoint id');
    assert(readFileSync(targetPath, 'utf-8') === 'after\n', 'checkpoint smoke: file_write did not mutate fixture file');

    const restoreCheckpointViaCli = (checkpointId: string): void => {
      const restore = spawnSync(process.execPath, [
        '--no-warnings',
        '--import',
        'tsx',
        join(packageRoot, 'src', 'index.ts'),
        'checkpoint',
        'restore',
        checkpointId,
        '--run',
        runDir,
        '--json',
      ], {
        cwd: packageRoot,
        encoding: 'utf-8',
        env: {
          ...process.env,
          BABEL_ALLOWED_ROOTS: base,
          BABEL_DRY_RUN: 'false',
          BABEL_DRY_RUN_SOURCE: 'session',
          BABEL_ENV: 'test',
          BABEL_PROJECT_ROOT: projectRoot,
          BABEL_ROOT: babelRoot,
          BABEL_RUNS_DIR: runsDir,
          NO_COLOR: '1',
        },
      });

      assert(
        (restore.status ?? 1) === 0,
        `checkpoint smoke: restore CLI failed with ${restore.status}\nstdout: ${restore.stdout}\nstderr: ${restore.stderr}`,
      );

      const parsed = parseJsonOutput(restore.stdout, 'checkpoint smoke: restore CLI') as {
        status?: string;
        checkpoint_id?: string;
        restored_files?: string[];
      };
      assert(parsed.status === 'restored', `checkpoint smoke: expected restored status, got ${JSON.stringify(parsed)}`);
      assert(parsed.checkpoint_id === checkpointId, 'checkpoint smoke: restored checkpoint id mismatch');
      assert(
        parsed.restored_files?.some((file) => resolve(file) === resolve(targetPath)),
        'checkpoint smoke: restored files did not include target path',
      );
    };

    const checkpointId = writeResult.checkpoint_ids[0]!;
    restoreCheckpointViaCli(checkpointId);
    assert(readFileSync(targetPath, 'utf-8') === 'before\n', 'checkpoint smoke: target file was not restored');

    const shellResult = await executeTool({
      tool: 'shell_exec',
      command: 'node mutate.js',
      working_directory: '.',
      timeout_seconds: 30,
    }, {
      agentId: 'checkpoint-smoke',
      runId,
      runDir,
      babelRoot,
    });

    assert(shellResult.exit_code === 0, `checkpoint smoke: shell_exec failed: ${shellResult.stderr}`);
    assert(shellResult.checkpoint_ids?.length === 1, 'checkpoint smoke: shell_exec did not return one checkpoint id');
    assert(readFileSync(targetPath, 'utf-8') === 'shell-after\n', 'checkpoint smoke: shell_exec did not mutate fixture file');

    restoreCheckpointViaCli(shellResult.checkpoint_ids[0]!);
    assert(readFileSync(targetPath, 'utf-8') === 'before\n', 'checkpoint smoke: shell_exec target file was not restored');
  } finally {
    restoreEnv(previousEnv);
    rmSync(base, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-smoke-fixtures-'));
  const projectRoot = pickProjectRoot();

  try {
    const fixtures = buildSmokeFixtures(runDir, projectRoot);
    assert(fixtures.length === 4, 'expected four smoke fixtures');

    for (const fixture of fixtures) {
      const fullPath = fixture.path;
      assert(existsSync(fullPath), `${fixture.name}: fixture file missing`);
      const parsed = SwePlanSchema.parse(JSON.parse(readFileSync(fullPath, 'utf-8')));
      assert(parsed.thinking.trim().length > 0, `${fixture.name}: missing thinking`);
      assert(parsed.minimal_action_set.length > 0, `${fixture.name}: empty action set`);
    }

    await assertCheckpointRestoreSmoke();
    console.log('smoke fixture schema and checkpoint restore regression tests passed');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
