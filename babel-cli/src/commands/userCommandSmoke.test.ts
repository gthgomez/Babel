import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const cliRoot = resolve(dirname(thisFile), '..', '..');
const entry = join(cliRoot, 'src', 'index.ts');
const smokeProfile = mkdtempSync(join(tmpdir(), 'babel-command-smoke-profile-'));
mkdirSync(join(smokeProfile, 'config'));
const smokeEnv = { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'], CI: '1', BABEL_CONFIG_DIR: join(smokeProfile, 'config'), BABEL_STATE_DIR: smokeProfile, BABEL_CACHE_DIR: join(smokeProfile, 'cache'), BABEL_RUNS_DIR: join(smokeProfile, 'runs') };

function runCli(args: string[], overrides: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(join(cliRoot, 'scripts/block_consumer_network.mjs')).href, entry, ...args], {
    cwd: cliRoot,
    env: { ...smokeEnv, ...overrides },
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test('top-level help is user-shaped before internals', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /babel-agent setup/);
  assert.match(result.stdout, /plan[\s\S]*read-only plan/i);
  assert.match(result.stdout, /work --review thorough/i);
  assert.match(result.stdout, /No cloud provider is preselected/);
  assert.match(result.stdout, /Plan stops by default/);
  assert.doesNotMatch(result.stdout, /\bmcp\s+Manage MCP/);
});

test('advanced tier keeps internal commands discoverable', () => {
  const result = runCli(['advanced']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Babel Advanced Commands/);
  assert.match(result.stdout, /simplify .*cleanup audit/i);
  assert.match(result.stdout, /docs .*documentation authority/i);
  assert.match(result.stdout, /mcp .*MCP/i);
  assert.match(result.stdout, /benchmark .*benchmark/i);
  assert.match(result.stdout, /ship/i);
});

test('docs audit command emits deterministic JSON', () => {
  const result = runCli(['docs', 'audit', '--json']);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as {
    status: string;
    summary: { errors: number; warnings: number; checkedDocs: number };
  };
  assert.notEqual(payload.status, 'fail');
  assert.equal(payload.summary.errors, 0);
  assert.ok(payload.summary.warnings >= 0);
  assert.ok(payload.summary.checkedDocs > 0);
});

test('simplify command emits deterministic JSON without model calls', () => {
  const result = runCli(['simplify', 'src/cli/argv.ts', '--json']);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as {
    schema_version: number;
    proof: { no_model_call: boolean; docs_audit_status: string; source_provenance_status: string };
    scan: { mode: string; target: string | null };
  };
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.proof.no_model_call, true);
  assert.notEqual(payload.proof.docs_audit_status, 'fail');
  assert.equal(payload.proof.source_provenance_status, 'pass');
  assert.equal(payload.scan.mode, 'target');
});

test('removed lite surface exits with a canonical replacement hint', () => {
  const result = runCli(['lite', '--help']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /babel lite was removed/i);
  assert.match(result.stderr, /babel "<task>"/);
});

test('removed full surface exits with deep replacement hint', () => {
  const result = runCli(['full', 'harden the plan']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /babel full was removed/i);
  assert.match(result.stderr, /babel deep/);
});

test('ship help exposes the guarded GitHub workflow', () => {
  const result = runCli(['ship', '--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /guarded AGENTS\.md/i);
  assert.match(result.stdout, /--apply/);
  assert.match(result.stdout, /--check/);
  assert.match(result.stdout, /--allow-remote/);
  assert.match(result.stdout, /Hard stops include/);
});

function writeProofFixture(): string {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-proof-command-'));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, '01_manifest.json'),
    JSON.stringify({
      target_project: 'test_project',
      analysis: {
        pipeline_mode: 'deep',
        task_summary: 'Fix the command smoke test',
      },
    }),
    'utf-8',
  );
  writeFileSync(
    join(runDir, '06_runtime_telemetry.json'),
    JSON.stringify({
      final_outcome: 'COMPLETE',
      pipeline_mode: 'deep',
      qa_verdict: 'PASS',
    }),
    'utf-8',
  );
  writeFileSync(
    join(runDir, '04_execution_report.json'),
    JSON.stringify({
      status: 'EXECUTION_COMPLETE',
      steps_executed: 2,
      tool_call_log: [
        { tool: 'file_write', target: 'src/example.ts', exit_code: 0 },
        { tool: 'test_run', target: 'npm test -- example', exit_code: 0, verified: true },
      ],
    }),
    'utf-8',
  );
  return runDir;
}

function writeFailedProofFixture(): string {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-proof-command-failed-'));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, '01_manifest.json'),
    JSON.stringify({
      target_project: 'test_project',
      analysis: {
        pipeline_mode: 'deep',
        task_summary: 'Fix the failing command smoke test',
      },
    }),
    'utf-8',
  );
  writeFileSync(
    join(runDir, '06_runtime_telemetry.json'),
    JSON.stringify({
      final_outcome: 'FAILED',
      pipeline_mode: 'deep',
      qa_verdict: 'PASS',
    }),
    'utf-8',
  );
  writeFileSync(
    join(runDir, '04_execution_report.json'),
    JSON.stringify({
      status: 'EXECUTION_HALTED',
      steps_executed: 2,
      tool_call_log: [
        { tool: 'file_write', target: 'src/example.ts', exit_code: 0 },
        { tool: 'test_run', target: 'npm test -- example', exit_code: 1, verified: false },
      ],
    }),
    'utf-8',
  );
  return runDir;
}

test('prove command writes proof artifacts for an explicit run directory', () => {
  const runDir = writeProofFixture();
  const result = runCli(['prove', runDir, '--json']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /VERIFIED_COMPLETE/);
  assert.equal(existsSync(join(runDir, 'proof_status.json')), true);
  assert.equal(existsSync(join(runDir, 'BABEL_RUN_REPORT.md')), true);
});

test('inspect --report writes proof artifacts from the inspection surface', () => {
  const runDir = writeProofFixture();
  const result = runCli(['inspect', '--report', '--run', runDir]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /STATUS: VERIFIED_COMPLETE/);
  assert.equal(existsSync(join(runDir, 'proof_status.json')), true);
  assert.equal(existsSync(join(runDir, 'BABEL_RUN_REPORT.md')), true);
});

test('prove refuses to write proof artifacts into non-run directories', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-proof-command-not-run-'));
  const result = runCli(['prove', runDir, '--json']);

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /not a Babel run evidence directory/);
  assert.equal(existsSync(join(runDir, 'proof_status.json')), false);
  assert.equal(existsSync(join(runDir, 'BABEL_RUN_REPORT.md')), false);
});

test('learn from-run writes a learning failure record', () => {
  const runDir = writeProofFixture();
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-command-'));
  const result = runCli(['learn', 'from-run', runDir, '--learning-root', learningRoot, '--json']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NO_FAILURE_DETECTED/);
  assert.equal(existsSync(join(learningRoot, 'failures')), true);
});

test('learn inspect reads a learning failure record by run id', () => {
  const runDir = writeProofFixture();
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-command-'));
  const create = runCli(['learn', 'from-run', runDir, '--learning-root', learningRoot, '--json']);

  assert.equal(create.status, 0, create.stderr);
  const runId = runDir.split(/[\\/]/).pop();
  assert.ok(runId);

  const inspect = runCli(['learn', 'inspect', runId, '--learning-root', learningRoot, '--json']);

  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stdout, /babel_learning_failure/);
  assert.match(inspect.stdout, /NO_FAILURE_DETECTED/);
});

test('learn propose, test, promote, and inspect support shadow lesson lifecycle', () => {
  const runDir = writeFailedProofFixture();
  const learningRoot = mkdtempSync(join(tmpdir(), 'babel-learning-command-'));
  const create = runCli(['learn', 'from-run', runDir, '--learning-root', learningRoot, '--json']);

  assert.equal(create.status, 0, create.stderr);
  const runId = runDir.split(/[\\/]/).pop();
  assert.ok(runId);

  const propose = runCli(['learn', 'propose', runId, '--learning-root', learningRoot, '--json']);
  assert.equal(propose.status, 0, propose.stderr);
  assert.match(propose.stdout, /babel_lesson_candidate/);
  const proposed = JSON.parse(propose.stdout) as { lesson: { lesson_id: string } };
  const lessonId = proposed.lesson.lesson_id;

  const evaluated = runCli(['learn', 'test', lessonId, '--learning-root', learningRoot, '--json']);
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.match(evaluated.stdout, /babel_lesson_eval/);
  assert.match(evaluated.stdout, /"status": "passed"/);

  const promoted = runCli([
    'learn',
    'promote',
    lessonId,
    '--shadow',
    '--learning-root',
    learningRoot,
    '--json',
  ]);
  assert.equal(promoted.status, 0, promoted.stderr);
  assert.match(promoted.stdout, /"status": "shadow"/);

  const packaged = runCli([
    'learn',
    'package',
    lessonId,
    '--target',
    'project-verifier-contract',
    '--learning-root',
    learningRoot,
    '--json',
  ]);
  assert.equal(packaged.status, 0, packaged.stderr);
  assert.match(packaged.stdout, /babel_mutation_package/);
  assert.match(packaged.stdout, /approval_identity_sha256/);

  const inspect = runCli(['learn', 'inspect', lessonId, '--learning-root', learningRoot, '--json']);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stdout, /babel_lesson_candidate/);
  assert.match(inspect.stdout, /"status": "shadow"/);
});


test('fresh setup and settings are noninteractive, provider neutral and model identity stays unobserved', () => {
  const setup = runCli(['setup', '--json']); assert.equal(setup.status, 0, setup.stderr);
  const status = JSON.parse(setup.stdout); assert.equal(status.mutates_workspace, false); assert.equal(status.state, 'setup_required'); assert.equal(status.provider, null);
  const settings = runCli(['settings', 'show', '--json']); assert.equal(settings.status, 0, settings.stderr);
  const inventory = JSON.parse(settings.stdout); assert.equal(inventory.effective.connection.value, null);
  assert.equal(inventory.effective.autoApply.value, false); assert.equal(inventory.identity.observedModel, null);
  for (const name of ['exec', 'daemon', 'goal', 'provider', 'model', 'conversation']) {
    const help = runCli([name, '--help']); assert.equal(help.status, 0, help.stderr); assert.doesNotMatch(help.stderr, /API_KEY|inference/);
  }
})


test('fresh plan fails with setup guidance before choosing a cloud account', () => {
  const result = runCli(['plan', 'Explain the intended changes', '--json']);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /SETUP_REQUIRED/);
  assert.doesNotMatch(result.stdout + result.stderr, /HTTP 401|\[openRouterApi\]|at new ChatEngine/);
})


test('a CLI connection flag has invocation provenance and does not save or leak a default', () => {
  const connected = runCli(['provider', 'connect', 'openai', '--name', 'fixture-account', '--model', 'Vendor/ExactCase']); assert.equal(connected.status, 0, connected.stderr)
  const status = runCli(['--connection', 'fixture-account', 'provider', 'status', '--json']); assert.equal(status.status, 0, status.stderr)
  const selection = JSON.parse(status.stdout); assert.equal(selection.provider, 'openai'); assert.equal(selection.model, 'Vendor/ExactCase'); assert.equal(selection.selectionSource, 'invocation')
  const next = runCli(['provider', 'status', '--json']); assert.equal(JSON.parse(next.stdout).connection, null)
})

test('plan shadow restriction overrides saved automatic application through the real entry point', () => {
  const profile = mkdtempSync(join(tmpdir(), 'babel-shadow-profile-'))
  const project = mkdtempSync(join(tmpdir(), 'babel-shadow-project-'))
  writeFileSync(join(project, 'README.md'), 'Fixture project\n')
  writeFileSync(join(profile, 'preferences.json'), JSON.stringify({ schemaVersion: 1, connections: {}, defaults: { plans: { autoApply: true }, budgetUsd: 'unlimited' } }))
  const result = runCli(['plan', 'Plan a documentation change', '--project-root', project, '--shadow'], { BABEL_STATE_DIR: profile, BABEL_LITE_OFFLINE: '1', BABEL_OFFLINE: '1' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /--shadow now keeps planning read-only/)
  assert.doesNotMatch(result.stderr, /Automatic application enabled/)
  assert.equal(existsSync(join(project, 'README.md')), true)
})
