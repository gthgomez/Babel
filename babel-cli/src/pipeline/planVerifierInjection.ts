import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ActionStep, SwePlan } from '../schemas/agentContracts.js';
import { isVerifierCommand } from '../services/terminalStatus.js';

function splitCommandList(raw: string): string[] {
  return raw
    .split(/\s+&&\s+|;\s+/)
    .map(cleanCommand)
    .filter(Boolean);
}

function trimTrailingTaskLabels(raw: string): string {
  return raw.replace(
    /\s+\b(?:Expected outcome|Allowed files?|Allowed director(?:y|ies)|Forbidden files?|Risk rating|Task id)\s*:.*$/i,
    '',
  );
}

function cleanCommand(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(
      /\s+from\s+(?:the\s+)?[A-Za-z0-9_.\\/-]+(?:\s+(?:directory|folder|subdirectory))?$/i,
      '',
    )
    .replace(/[.。]\s*$/, '')
    .trim();
}

function uniqueCommands(commands: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const command of commands.map(cleanCommand).filter(Boolean)) {
    const normalized = command.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      output.push(command);
    }
  }
  return output;
}

export function extractRequiredVerifierCommandsFromTask(task: string): string[] {
  const commands: string[] = [];
  for (const line of task.split(/\r?\n/)) {
    const match = line.match(/\bVerifier commands?\s*:\s*(.+)$/i);
    if (match?.[1]) {
      commands.push(...splitCommandList(trimTrailingTaskLabels(match[1])));
    }
  }
  const runBeforePattern = /\bRun\s+([^\n.;]+?)\s+before\s+completing\b/gi;
  for (const match of task.matchAll(runBeforePattern)) {
    if (match[1]) {
      commands.push(cleanCommand(match[1]));
    }
  }
  const verifierIsPattern = /\bverifier\s+(?:is|:)\s*([^\n.;]+)/gi;
  for (const match of task.matchAll(verifierIsPattern)) {
    if (match[1]) {
      commands.push(cleanCommand(match[1]));
    }
  }
  return uniqueCommands(commands.filter((command) => isVerifierCommand(command)));
}

function looksLikeTestCommand(command: string): boolean {
  return /\b(npm\s+test|node\s+--test|pnpm\s+test|yarn\s+test|pytest|jest|vitest|cargo\s+test|go\s+test)\b/i.test(
    command,
  );
}

function discoverDefaultVerifierCommands(projectRoot: string): string[] {
  const packagePath = join(projectRoot, 'package.json');
  if (!existsSync(packagePath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = parsed.scripts ?? {};
    const commands: string[] = [];
    if (typeof scripts['test'] === 'string' && scripts['test'].trim().length > 0) {
      commands.push('npm test');
    }
    if (typeof scripts['typecheck'] === 'string' && scripts['typecheck'].trim().length > 0) {
      commands.push('npm run typecheck');
    }
    return commands;
  } catch {
    return [];
  }
}

export function plannedVerificationCommandsFromPlan(plan: SwePlan | null | undefined): string[] {
  return (plan?.minimal_action_set ?? [])
    .filter((step) => {
      const tool = String(step.tool ?? '');
      const target = String(step.target ?? '');
      if (tool === 'test_run') {
        return true;
      }
      // Recognise both explicit verifier commands (test, check, verify, lint,
      // typecheck, build) AND synthesized content-read verification commands
      // (type <file> on Windows, cat <file> on Linux/Mac) injected by
      // synthesizeVerifierCommandsFromWriteTargets.
      return (
        tool === 'shell_exec' &&
        (/\b(test|check|verify|lint|typecheck|build)\b/i.test(target) ||
          /^(?:type|cat)\s+\S/i.test(target))
      );
    })
    .map((step) => String(step.target ?? ''));
}

export function hasImplementationVerificationStrategy(plan: SwePlan | null | undefined): boolean {
  if (plannedVerificationCommandsFromPlan(plan).length > 0) {
    return true;
  }
  return (plan?.minimal_action_set ?? []).some((step) => {
    const text = `${step.description ?? ''} ${step.target ?? ''} ${step.verification ?? ''}`;
    return /\b(verif|test|check|lint|typecheck|build)/i.test(text);
  });
}

function buildVerificationStep(command: string, stepNumber: number): ActionStep {
  const tool = looksLikeTestCommand(command) ? 'test_run' : 'shell_exec';
  return {
    step: stepNumber,
    description: `Auto-injected verification: ${command}`,
    tool,
    target: command,
    rationale: 'Verifier auto-injected from task text or package.json before file edits unlock.',
    reversible: true,
    verification: `Exit code 0 for ${command}`,
  };
}

// ─── Synthesized verification from file-write targets ──────────────────────────
//
// When a plan includes file_write steps but no verification commands can be
// discovered from the task text or package.json, we synthesize content-verification
// steps that read back the written files. This prevents the counter-agent critique
// from blocking trivial plans (e.g. "Create X.txt containing Y") that cheap-tier
// planner models often produce without verification.

const TEXT_FILE_EXTENSION_FOR_SYNTHESIS =
  /\.(?:c|cc|cpp|cs|css|csv|gd|go|h|hpp|html|java|js|jsx|json|kt|log|md|mjs|ps1|py|rb|rs|sh|sql|svg|ts|tsx|txt|xml|yaml|yml)$/i;

function synthContentReadCommand(target: string): string {
  // Use a cross-platform content-read command that the executor sandbox allows.
  // On Windows: `type file`; elsewhere: `cat file`.
  // No quotes — cmd.exe /c type resolves the filename relative to the working
  // directory, and quoting interferes with argument parsing through spawn.
  const cmd = process.platform === 'win32' ? 'type' : 'cat';
  // Normalize backslashes to forward slashes to avoid triggering the shell
  // operator check in sandbox.ts (backslash is a path separator on Windows,
  // not a shell metacharacter).
  const normalizedTarget = target.replace(/\\/g, '/');
  return `${cmd} ${normalizedTarget}`;
}

function synthesizeVerifierCommandsFromWriteTargets(plan: SwePlan): string[] {
  return (plan.minimal_action_set ?? [])
    .filter((step) => String(step.tool ?? '') === 'file_write')
    .map((step) => String(step.target ?? '').trim())
    .filter((target) => target.length > 0 && TEXT_FILE_EXTENSION_FOR_SYNTHESIS.test(target))
    .map((target) => synthContentReadCommand(target));
}

function buildSynthesizedVerificationStep(command: string, stepNumber: number): ActionStep {
  return {
    step: stepNumber,
    description: `Verify file content: ${command}`,
    tool: 'shell_exec',
    target: command,
    rationale: 'Auto-injected file-content verification synthesized from plan write targets.',
    reversible: true,
    verification: 'Verify written file content is present and readable (exit code 0).',
  };
}

export function injectVerificationStepsIntoPlan(
  plan: SwePlan,
  task: string,
  projectRoot: string | null,
): { plan: SwePlan; injected: boolean; commands: string[] } {
  if (plan.plan_type !== 'IMPLEMENTATION_PLAN') {
    return { plan, injected: false, commands: [] };
  }
  if (plannedVerificationCommandsFromPlan(plan).length > 0) {
    return { plan, injected: false, commands: [] };
  }

  let commands = extractRequiredVerifierCommandsFromTask(task);
  if (commands.length === 0 && projectRoot) {
    commands = discoverDefaultVerifierCommands(projectRoot);
  }
  // Fallback: synthesize content-read verification from the plan's own file_write targets.
  // This catches trivial file-creation plans that cheap-tier models produce without
  // explicit verification steps — the most common EXECUTOR_HALTED cause in reliability runs.
  if (commands.length === 0) {
    commands = synthesizeVerifierCommandsFromWriteTargets(plan);
  }
  if (commands.length === 0) {
    return { plan, injected: false, commands: [] };
  }

  const isSynthesized = commands.every((cmd) => /^(?:type|cat) /.test(cmd));
  const actionSet = [...plan.minimal_action_set];
  const firstWriteIndex = actionSet.findIndex((step) => step.tool === 'file_write');

  // Test/typecheck verifiers (from task text or package.json) run BEFORE file_write
  // to catch pre-existing issues. Synthesized content-read verifiers (type/cat) run
  // AFTER file_write because the file doesn't exist yet.
  const insertIndex = isSynthesized
    ? (() => {
        const lastWriteIndex = actionSet.reduce(
          (last, step, i) => (step.tool === 'file_write' ? i : last),
          -1,
        );
        return lastWriteIndex >= 0 ? lastWriteIndex + 1 : actionSet.length;
      })()
    : firstWriteIndex >= 0
      ? firstWriteIndex
      : actionSet.length;

  const verificationSteps = commands.map((command, index) =>
    isSynthesized
      ? buildSynthesizedVerificationStep(command, insertIndex + index + 1)
      : buildVerificationStep(command, insertIndex + index + 1),
  );
  actionSet.splice(insertIndex, 0, ...verificationSteps);
  const renumbered = actionSet.map((step, index) => ({
    ...step,
    step: index + 1,
  }));

  return {
    plan: {
      ...plan,
      minimal_action_set: renumbered,
    },
    injected: true,
    commands,
  };
}
