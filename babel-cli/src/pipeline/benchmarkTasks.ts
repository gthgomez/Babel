import type { SwePlan } from '../schemas/agentContracts.js';
import { normalizePathForComparison } from '../stages/taskShape.js';
import { BENCHMARK_INSTALL_RECOVERY_TAG } from './paths.js';

export function isExternalBenchmarkTask(rawTask: string): boolean {
  return /\bTerminal-Bench 2 task\b/i.test(rawTask) || /\bSWE-rebench\b/i.test(rawTask);
}

export function normalizeShellCommandForComparison(command: string): string {
  return command.replace(/\s+/g, ' ').trim().toLowerCase();
}

function getShellCommandSegments(command: string): string[] {
  return normalizeShellCommandForComparison(command)
    .split(/&&|\|\||[;|]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export function isInvalidGitBundleArchiveCommand(rawTask: string, command: string): boolean {
  if (!/\bmerge-diff-arc-agi-task\b/i.test(rawTask) && !/\.bundle\b/i.test(command)) {
    return false;
  }

  return getShellCommandSegments(command).some(
    (segment) => /^(?:tar|gzip|gunzip|zcat)\b/.test(segment) && /\.bundle\b/.test(segment),
  );
}

export function isBenchmarkDependencyInstallCommand(command: string): boolean {
  return getShellCommandSegments(command).some(
    (segment) =>
      /^(?:sudo\s+)?(?:apt-get|apt)\s+(?:update|install|upgrade|dist-upgrade|full-upgrade)\b/.test(
        segment,
      ) ||
      /^(?:sudo\s+)?(?:pip|pip3)\s+install\b/.test(segment) ||
      /^(?:sudo\s+)?(?:python|python3|py)\s+-m\s+pip\s+install\b/.test(segment) ||
      /^(?:sudo\s+)?uv\s+pip\s+install\b/.test(segment) ||
      /^(?:sudo\s+)?(?:conda|mamba)\s+install\b/.test(segment),
  );
}

export function benchmarkTaskExplicitlyAllowsDependencyInstall(rawTask: string): boolean {
  return (
    /\b(?:install|provision|download|add)\s+(?:the\s+)?(?:dependencies|requirements|packages|modules)\b/i.test(
      rawTask,
    ) ||
    /\b(?:pip|pip3|python3?|py)\s+-m\s+pip\s+install\b/i.test(rawTask) ||
    /\b(?:pip|pip3|uv\s+pip|apt-get|apt|conda|mamba)\s+install\b/i.test(rawTask)
  );
}

function approvedPlanHasExactInstallCommand(approvedPlan: SwePlan, command: string): boolean {
  const normalizedCommand = normalizeShellCommandForComparison(command);
  return approvedPlan.minimal_action_set.some(
    (step) =>
      (step.tool === 'shell_exec' || step.tool === 'test_run') &&
      isBenchmarkDependencyInstallCommand(String(step.target ?? '')) &&
      normalizeShellCommandForComparison(String(step.target ?? '')) === normalizedCommand,
  );
}

export function getBenchmarkDependencyInstallPlanReject(
  rawTask: string,
  command: string,
): string | null {
  if (!isBenchmarkDependencyInstallCommand(command)) {
    return null;
  }
  if (benchmarkTaskExplicitlyAllowsDependencyInstall(rawTask)) {
    return null;
  }

  return (
    `[BENCHMARK_DEPENDENCY_INSTALL_PLAN] Benchmark plans must not install dependencies ` +
    `unless the task explicitly requests dependency installation. Command: ${command}`
  );
}

export function getBenchmarkInstallRecoveryBlockReason(
  approvedPlan: SwePlan,
  rawTask: string,
  command: string,
): string | null {
  if (!isBenchmarkDependencyInstallCommand(command)) {
    return null;
  }
  if (approvedPlanHasExactInstallCommand(approvedPlan, command)) {
    return null;
  }
  if (benchmarkTaskExplicitlyAllowsDependencyInstall(rawTask)) {
    return null;
  }

  return (
    `[${BENCHMARK_INSTALL_RECOVERY_TAG}] Command "${command}" is a dependency ` +
    `installation command that was not in the approved SWE plan. Benchmark recovery must ` +
    `use existing container capabilities or source-only/file_write artifacts instead of ` +
    `spending turns on package installation. If no source-only route exists, halt with ` +
    `STEP_VERIFICATION_FAIL and name the missing runtime dependency.`
  );
}

export function getExternalRepairRerunLimit(rawTask: string): number {
  if (/\bbreak-filter-js-from-html\b/i.test(rawTask)) {
    return 3;
  }
  if (isExternalBenchmarkTask(rawTask)) {
    return 4;
  }
  return 0;
}

export function shouldHaltExternalRepairRerun(rawTask: string, rerunCount: number): boolean {
  const limit = getExternalRepairRerunLimit(rawTask);
  return limit > 0 && rerunCount > limit;
}

export function getExternalBenchmarkDefaultLockedFiles(rawTask: string): string[] {
  if (!isExternalBenchmarkTask(rawTask)) {
    return [];
  }

  const locks = ['test_outputs.py'];
  if (/\bbreak-filter-js-from-html\b/i.test(rawTask)) {
    locks.push('filter.py');
  }
  return locks;
}

export function getBenchmarkProtectedWriteReason(rawTask: string, target: string): string | null {
  const normalizedTarget = normalizePathForComparison(target).replace(/^\.\//, '');
  const normalizedBase =
    normalizedTarget.split('/').pop()?.toLowerCase() ?? normalizedTarget.toLowerCase();
  const protectedFiles = getExternalBenchmarkDefaultLockedFiles(rawTask);
  const protectedMatch = protectedFiles.find((file) => {
    const normalizedProtected = normalizePathForComparison(file).replace(/^\.\//, '').toLowerCase();
    return (
      normalizedTarget.toLowerCase() === normalizedProtected ||
      normalizedBase === normalizedProtected.split('/').pop()
    );
  });

  if (!protectedMatch) {
    return null;
  }

  return (
    `[BENCHMARK_PROTECTED_FIXTURE_WRITE] Refusing to write "${target}". ` +
    `External benchmark verifier/input fixtures such as "${protectedMatch}" must remain immutable; ` +
    `repair the requested output artifact or write a new helper script instead.`
  );
}

export function shouldEnforceBoundedPlanActivationContract(rawTask: string): boolean {
  return !isExternalBenchmarkTask(rawTask);
}
