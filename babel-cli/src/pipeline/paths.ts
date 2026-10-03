import { join } from 'node:path';
import { resolveRuntimePaths, resolveRuntimeRunsDir } from '../config/runtimePaths.js';

/** Immutable prompt library root; source BABEL_ROOT overrides remain supported. */
export const BABEL_ROOT = resolveRuntimePaths().resourceRoot;
export const BABEL_RUNS_DIR = resolveRuntimeRunsDir();
export const GRADLE_CACHE_DIR = join(resolveRuntimePaths().userCacheRoot, 'gradle-distributions');

/** Maximum SWE -> QA iterations before halting with an error. */
export const MAX_SWE_QA_LOOPS = 3;
/** Maximum multi-turn rounds in the executor loop. */
export const MAX_EXECUTOR_TURNS = 20;
/** Maximum replan attempts when the same failure fingerprint repeats. */
export const MAX_REPLAN_ATTEMPTS = 2;
/** Maximum times the SWE Agent may request evidence before the pipeline halts. */
export const MAX_EVIDENCE_LOOPS = 2;
export const OBJECTIVE_PREFIX = 'OBJECTIVE: ';
export const DEFAULT_ORCHESTRATOR_VERSION = 'v9' as const;
export const BENCHMARK_INSTALL_RECOVERY_TAG = 'BENCHMARK_INSTALL_RECOVERY_BLOCKED';

export type OrchestratorRuntimeVersion = 'v9';

const ORCHESTRATOR_PATHS_V9 = [
  '01_Behavioral_OS/OLS-v11-Core-Unified.md',
  '00_System_Router/OLS-v9-Orchestrator.md',
];

export const QA_PATHS = [
  '01_Behavioral_OS/OLS-v11-Core-Unified.md',
  '07_Pipeline_Stages/QA_Adversarial_Reviewer-v1.0.md',
];

export const EXECUTOR_PATHS = [
  '01_Behavioral_OS/OLS-v11-Core-Unified.md',
  '07_Pipeline_Stages/CLI_Executor-v1.0.md',
];

export function abs(relativePaths: readonly string[]): string[] {
  return relativePaths.map((p) => join(resolveRuntimePaths().resourceRoot, p));
}

export function resolveOrchestratorVersion(requestedVersion?: string): OrchestratorRuntimeVersion {
  const rawVersion =
    requestedVersion?.trim() ||
    process.env['BABEL_ORCHESTRATOR_VERSION']?.trim() ||
    DEFAULT_ORCHESTRATOR_VERSION;

  if (rawVersion === 'v9') {
    return rawVersion;
  }

  throw new Error(`Invalid orchestrator version "${rawVersion}". Only v9 is supported.`);
}

export function getOrchestratorPaths(_version: OrchestratorRuntimeVersion): string[] {
  return ORCHESTRATOR_PATHS_V9;
}
