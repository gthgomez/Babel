import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { loadPlanHandoff } from '../agent/planHandoff.js';
import { BABEL_ROOT } from '../cli/constants.js';
import { acquireLock, releaseLock } from '../utils/locking.js';
import { getShadowDiff } from './shadowDiff.js';
import { runSmallFixPath, type SmallFixResult } from './smallFix.js';

export type DogfoodIsolation = 'shadow' | 'git_worktree';

export interface RunDogfoodOptions {
  task: string;
  projectRoot: string;
  isolation: DogfoodIsolation;
  planRunId?: string;
  provider?: 'live' | 'mock';
}

export interface DogfoodPromoteArtifact {
  schema_version: 1;
  artifact_type: 'babel_dogfood_promote';
  run_id: string;
  isolation: DogfoodIsolation;
  project_root: string;
  workspace_root: string;
  fix_status: string;
  changed_files: string[];
  plan_run_id: string | null;
  shadow_diff_path: string | null;
  next_recommended_operator_action: string;
}

export interface DogfoodRunResult {
  status: 'DOGFOOD_COMPLETE' | 'DOGFOOD_FAILED';
  runId: string;
  runDir: string;
  workspaceRoot: string;
  isolation: DogfoodIsolation;
  fixResult: SmallFixResult;
  promoteArtifactPath: string;
  shadowDiffPath: string | null;
}

function createDogfoodRunDir(projectRoot: string): { runId: string; runDir: string } {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const runId = `${timestamp}Z-dogfood-${randomBytes(4).toString('hex')}`;
  const runDir = join(resolve(projectRoot), '.babel', 'dogfood', runId);
  mkdirSync(runDir, { recursive: true });
  return { runId, runDir };
}

function copyProjectSnapshot(projectRoot: string, workspaceRoot: string): void {
  mkdirSync(workspaceRoot, { recursive: true });
  cpSync(projectRoot, workspaceRoot, {
    recursive: true,
    force: true,
    filter: (sourcePath) => {
      const name = sourcePath.split(/[/\\]/).pop() ?? '';
      return !['.git', 'node_modules', 'dist', 'runs', '.babel'].includes(name);
    },
  });
}

function prepareGitWorktree(projectRoot: string, workspaceRoot: string): void {
  mkdirSync(dirname(workspaceRoot), { recursive: true });
  if (existsSync(workspaceRoot)) {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
  const result = spawnSync('git', ['worktree', 'add', '--detach', workspaceRoot, 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`git worktree add failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function restoreEnvValue(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = previous;
  }
}

export async function runDogfoodApply(options: RunDogfoodOptions): Promise<DogfoodRunResult> {
  const projectRoot = resolve(options.projectRoot);
  const { runId, runDir } = createDogfoodRunDir(projectRoot);
  const lock = acquireLock(projectRoot, BABEL_ROOT, 'dogfood', runId, 'dogfood apply');
  if (!lock.success) {
    throw new Error(lock.message);
  }

  const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
  const previousDryRun = process.env['BABEL_DRY_RUN'];
  const previousDryRunSource = process.env['BABEL_DRY_RUN_SOURCE'];
  const previousShadowRoot = process.env['BABEL_SHADOW_ROOT'];

  try {
    const planHandoff = loadPlanHandoff({
      repoPath: projectRoot,
      task: options.task,
      ...(options.planRunId !== undefined ? { planRunId: options.planRunId } : {}),
    });

    let workspaceRoot = projectRoot;
    let shadowDiffPath: string | null = null;

    if (options.isolation === 'git_worktree') {
      workspaceRoot = join(projectRoot, '.babel', 'worktrees', runId);
      prepareGitWorktree(projectRoot, workspaceRoot);
    } else {
      workspaceRoot = join(tmpdir(), 'babel-dogfood-shadow', runId);
      if (existsSync(workspaceRoot)) {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
      copyProjectSnapshot(projectRoot, workspaceRoot);
      process.env['BABEL_SHADOW_ROOT'] = workspaceRoot;
    }

    process.env['BABEL_PROJECT_ROOT'] = workspaceRoot;

    const fixResult = await runSmallFixPath({
      task: options.task,
      projectRoot: workspaceRoot,
      planHandoff,
      ...(options.planRunId !== undefined ? { planRunId: options.planRunId } : {}),
      provider: options.provider ?? 'mock',
    });

    if (options.isolation === 'shadow') {
      const diff = getShadowDiff(workspaceRoot, projectRoot);
      shadowDiffPath = join(runDir, 'shadow_diff.txt');
      writeFileSync(shadowDiffPath, diff.diff ?? diff.error ?? '', 'utf-8');
    }

    const promoteArtifactPath = join(runDir, 'dogfood_promote.json');
    const changedFiles = fixResult.status === 'SMALL_FIX_COMPLETE' ? fixResult.changedFiles : [];
    const promoteArtifact: DogfoodPromoteArtifact = {
      schema_version: 1,
      artifact_type: 'babel_dogfood_promote',
      run_id: runId,
      isolation: options.isolation,
      project_root: projectRoot,
      workspace_root: workspaceRoot,
      fix_status: fixResult.status,
      changed_files: changedFiles,
      plan_run_id: planHandoff?.planRunId ?? options.planRunId ?? null,
      shadow_diff_path: shadowDiffPath,
      next_recommended_operator_action:
        changedFiles.length > 0
          ? 'Review the dogfood artifact, then run `babel dogfood promote <run-id>` to copy changes into the live worktree.'
          : 'Inspect the dogfood run evidence and adjust the task before retrying.',
    };
    writeFileSync(promoteArtifactPath, `${JSON.stringify(promoteArtifact, null, 2)}\n`, 'utf-8');

    const status =
      fixResult.status === 'SMALL_FIX_COMPLETE' ? 'DOGFOOD_COMPLETE' : 'DOGFOOD_FAILED';
    return {
      status,
      runId,
      runDir,
      workspaceRoot,
      isolation: options.isolation,
      fixResult,
      promoteArtifactPath,
      shadowDiffPath,
    };
  } finally {
    restoreEnvValue('BABEL_PROJECT_ROOT', previousProjectRoot);
    restoreEnvValue('BABEL_DRY_RUN', previousDryRun);
    restoreEnvValue('BABEL_DRY_RUN_SOURCE', previousDryRunSource);
    restoreEnvValue('BABEL_SHADOW_ROOT', previousShadowRoot);
    releaseLock(projectRoot, BABEL_ROOT, runId);
  }
}

export function readDogfoodPromoteArtifact(
  projectRoot: string,
  runId: string,
): DogfoodPromoteArtifact {
  const promoteArtifactPath = join(
    resolve(projectRoot),
    '.babel',
    'dogfood',
    runId,
    'dogfood_promote.json',
  );
  if (!existsSync(promoteArtifactPath)) {
    throw new Error(`Dogfood promote artifact not found for run id "${runId}".`);
  }
  const parsed = JSON.parse(readFileSync(promoteArtifactPath, 'utf-8')) as DogfoodPromoteArtifact;
  if (parsed.artifact_type !== 'babel_dogfood_promote') {
    throw new Error(`Invalid dogfood promote artifact at ${promoteArtifactPath}.`);
  }
  return parsed;
}

export function promoteDogfoodRun(
  projectRoot: string,
  runId: string,
): {
  status: 'promoted';
  changedFiles: string[];
  promoteArtifactPath: string;
} {
  const artifact = readDogfoodPromoteArtifact(projectRoot, runId);
  if (artifact.changed_files.length === 0) {
    throw new Error(`Dogfood run "${runId}" has no changed files to promote.`);
  }

  const lock = acquireLock(artifact.project_root, BABEL_ROOT, 'dogfood', runId, 'dogfood promote');
  if (!lock.success) {
    throw new Error(lock.message);
  }

  try {
    const promoted: string[] = [];
    for (const relativePath of artifact.changed_files) {
      const source = join(artifact.workspace_root, relativePath);
      const target = join(artifact.project_root, relativePath);
      if (!existsSync(source)) {
        throw new Error(`Missing changed file in dogfood workspace: ${relativePath}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      promoted.push(relativePath);
    }

    const promoteArtifactPath = join(
      resolve(projectRoot),
      '.babel',
      'dogfood',
      runId,
      'dogfood_promote.json',
    );
    writeFileSync(
      promoteArtifactPath,
      `${JSON.stringify(
        {
          ...artifact,
          promoted_at: new Date().toISOString(),
          promoted_files: promoted,
          next_recommended_operator_action:
            'Review promoted files, run verifiers, and commit when ready.',
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    return {
      status: 'promoted',
      changedFiles: promoted,
      promoteArtifactPath,
    };
  } finally {
    releaseLock(artifact.project_root, BABEL_ROOT, runId);
  }
}
