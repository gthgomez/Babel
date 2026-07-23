import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Command } from 'commander';

import { resolveApprovedWorkspacePath } from '../services/workspaceManager.js';
import {
  promoteDogfoodRun,
  runDogfoodApply,
  type DogfoodIsolation,
} from '../services/dogfoodSandbox.js';
import { writeJson } from '../cli/structuredOutput.js';
import { validateRuntimeEnvForCommand } from './coreCommands.js';

function parseIsolation(value: string | undefined): DogfoodIsolation {
  if (value === 'git_worktree' || value === 'shadow') {
    return value;
  }
  throw new Error(`Invalid isolation "${value}". Valid values: shadow | git_worktree`);
}

async function handleDogfoodApply(
  taskParts: string[],
  options: {
    projectRoot?: string;
    isolation?: string;
    fromPlan?: string;
    provider?: string;
    json?: boolean;
  },
): Promise<void> {
  const task = taskParts.join(' ').trim();
  if (!task) {
    throw new Error('babel dogfood requires task text.');
  }

  validateRuntimeEnvForCommand({ json: options.json === true });
  const isolation = parseIsolation(options.isolation);
  const projectRoot = options.projectRoot
    ? resolveApprovedWorkspacePath(options.projectRoot).path
    : process.cwd();
  if (!existsSync(projectRoot)) {
    throw new Error(`Project root does not exist: ${projectRoot}`);
  }

  const provider = options.provider === 'live' ? 'live' : 'mock';
  const result = await runDogfoodApply({
    task,
    projectRoot: resolve(projectRoot),
    isolation,
    ...(options.fromPlan !== undefined ? { planRunId: options.fromPlan } : {}),
    provider,
  });

  const payload = {
    status: result.status,
    run_id: result.runId,
    run_dir: result.runDir,
    workspace_root: result.workspaceRoot,
    isolation: result.isolation,
    fix_status: result.fixResult.status,
    changed_files:
      result.fixResult.status === 'SMALL_FIX_COMPLETE' ? result.fixResult.changedFiles : [],
    promote_artifact_path: result.promoteArtifactPath,
    shadow_diff_path: result.shadowDiffPath,
    next:
      result.status === 'DOGFOOD_COMPLETE'
        ? [`babel dogfood promote ${result.runId}`]
        : ['Inspect the dogfood run evidence and retry with a narrower scoped task.'],
  };

  if (options.json === true) {
    writeJson(payload);
    process.exitCode = result.status === 'DOGFOOD_COMPLETE' ? 0 : 1;
    return;
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = result.status === 'DOGFOOD_COMPLETE' ? 0 : 1;
}

export function registerDogfoodCommands(program: Command): void {
  const dogfood = program
    .command('dogfood')
    .description(
      'Safely dogfood Babel on its own codebase with shadow preview or git worktree isolation',
    )
    .argument('<task...>', 'Task text to apply in the sandbox')
    .option('--project-root <path>', 'Explicit project root for the dogfood sandbox')
    .option('--isolation <mode>', 'Sandbox isolation: shadow | git_worktree', 'shadow')
    .option('--from-plan <planRunId>', 'Approved plan run id under runs/babel-lite/')
    .option('--provider <provider>', 'Provider for bounded fix lane: live | mock', 'mock')
    .option('--json', 'Emit structured JSON only')
    .addHelpText(
      'after',
      `
Examples:
  $ babel dogfood "Fix stale pointers" --isolation shadow --from-plan 20260610T180000Z-plan-abc123
  $ babel dogfood "Fix stale pointers" --isolation git_worktree --project-root .
  $ babel dogfood promote 20260610T180000Z-dogfood-deadbeef --json

Notes:
  - shadow copies the project to a temp workspace and leaves the live tree unchanged.
  - git_worktree mutates only a detached worktree under .babel/worktrees/.
  - promote copies changed files from the dogfood workspace into the live project root.
`,
    )
    .action(
      async (
        taskParts: string[],
        options: {
          projectRoot?: string;
          isolation?: string;
          fromPlan?: string;
          provider?: string;
          json?: boolean;
        },
      ) => {
        await handleDogfoodApply(taskParts, options);
      },
    );

  dogfood
    .command('promote <runId>')
    .description('Promote changed files from a completed dogfood run into the live project root')
    .option('--project-root <path>', 'Project root that owns the dogfood run artifact')
    .option('--json', 'Emit structured JSON only')
    .action((runId: string, options: { projectRoot?: string; json?: boolean }) => {
      validateRuntimeEnvForCommand({ json: options.json === true });
      const projectRoot = options.projectRoot
        ? resolveApprovedWorkspacePath(options.projectRoot).path
        : process.cwd();
      const result = promoteDogfoodRun(resolve(projectRoot), runId);
      const payload = {
        status: result.status,
        run_id: runId,
        changed_files: result.changedFiles,
        promote_artifact_path: result.promoteArtifactPath,
      };
      if (options.json === true) {
        writeJson(payload);
        return;
      }
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    });
}
