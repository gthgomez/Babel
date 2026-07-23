import type { ToolCallLog } from '../schemas/agentContracts.js';
import { MAX_REPLAN_ATTEMPTS } from '../pipeline/paths.js';

export type RepairStateStatus =
  | 'new_failure'
  | 'patch_pending'
  | 'rerun_required'
  | 'same_failure_repeated'
  | 'replan_requested'
  | 'strategy_exhausted';

export interface FailureFingerprint {
  readonly command: string;
  readonly exitCode: number;
  readonly stderrSummary: string;
  readonly stdoutSummary: string;
  readonly testId: string | null;
  readonly key: string;
}

export interface RepairFailureRecord {
  readonly failedStep: number;
  readonly fingerprint: FailureFingerprint;
  readonly repeatedCount: number;
}

export interface RepairState {
  readonly maxFailures: number;
  readonly failures: RepairFailureRecord[];
  readonly status: RepairStateStatus;
  readonly lastFingerprint: FailureFingerprint | null;
  readonly replanCount: number;
}

export interface RepairStateDecision {
  readonly state: RepairState;
  readonly shouldHalt: boolean;
  readonly shouldReplan: boolean;
  readonly condition: string | null;
}

export function createRepairState(maxFailures: number): RepairState {
  return {
    maxFailures,
    failures: [],
    status: 'new_failure',
    lastFingerprint: null,
    replanCount: 0,
  };
}

export function fingerprintToolFailure(entry: ToolCallLog): FailureFingerprint {
  const stderrSummary = normalizeDiagnostic(entry.stderr);
  const stdoutSummary = normalizeDiagnostic(entry.stdout);
  const testId = extractTestId(`${entry.stderr}\n${entry.stdout}`);
  const command = normalizeCommand(entry.target);
  const key = [command, entry.exit_code, testId ?? '', stderrSummary || stdoutSummary].join('|');
  return {
    command,
    exitCode: entry.exit_code,
    stderrSummary,
    stdoutSummary,
    testId,
    key,
  };
}

export function recordRepairFailure(state: RepairState, entry: ToolCallLog): RepairStateDecision {
  const fingerprint = fingerprintToolFailure(entry);
  const previous = state.failures[state.failures.length - 1] ?? null;
  const repeatedCount =
    previous && previous.fingerprint.key === fingerprint.key ? previous.repeatedCount + 1 : 1;
  const failures = [
    ...state.failures,
    {
      failedStep: entry.step,
      fingerprint,
      repeatedCount,
    },
  ];

  const exhausted = failures.length >= state.maxFailures;
  const sameFailureRepeated = repeatedCount >= 2;
  const replanAvailable = state.replanCount < MAX_REPLAN_ATTEMPTS;
  const nextStatus: RepairStateStatus = exhausted
    ? 'strategy_exhausted'
    : sameFailureRepeated && replanAvailable
      ? 'replan_requested'
      : sameFailureRepeated
        ? 'same_failure_repeated'
        : 'patch_pending';

  const nextState: RepairState = {
    ...state,
    failures,
    status: nextStatus,
    lastFingerprint: fingerprint,
    replanCount: nextStatus === 'replan_requested' ? state.replanCount + 1 : state.replanCount,
  };

  if (exhausted) {
    return {
      state: nextState,
      shouldHalt: true,
      shouldReplan: false,
      condition:
        `[EXECUTOR_RECOVERABLE_STRATEGY_EXHAUSTED] Recoverable command failure budget ` +
        `exceeded after ${failures.length} failure(s). Last fingerprint: ${formatFailureFingerprint(fingerprint)}.`,
    };
  }

  if (sameFailureRepeated) {
    if (replanAvailable) {
      return {
        state: nextState,
        shouldHalt: false,
        shouldReplan: true,
        condition:
          `[EXECUTOR_REPLAN_REQUESTED] Same recoverable failure repeated ` +
          `${repeatedCount} time(s): ${formatFailureFingerprint(fingerprint)}. ` +
          `Replan attempt ${nextState.replanCount}/${MAX_REPLAN_ATTEMPTS}.`,
      };
    }
    return {
      state: nextState,
      shouldHalt: false,
      shouldReplan: false,
      condition:
        `[EXECUTOR_REPEATED_FAILURE_FINGERPRINT] Same recoverable failure repeated ` +
        `${repeatedCount} time(s) after ${state.replanCount} replan(s): ${formatFailureFingerprint(fingerprint)}. ` +
        `Replan budget exhausted.`,
    };
  }

  return {
    state: nextState,
    shouldHalt: false,
    shouldReplan: false,
    condition: null,
  };
}

export function formatFailureFingerprint(fingerprint: FailureFingerprint): string {
  const parts = [
    `command="${fingerprint.command}"`,
    `exit=${fingerprint.exitCode}`,
    ...(fingerprint.testId ? [`test="${fingerprint.testId}"`] : []),
    `stderr="${fingerprint.stderrSummary || '(empty)'}"`,
    ...(fingerprint.stdoutSummary && !fingerprint.stderrSummary
      ? [`stdout="${fingerprint.stdoutSummary}"`]
      : []),
  ];
  return parts.join(' ');
}

function normalizeCommand(value: string): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeDiagnostic(value: string): string {
  return String(value ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^=+\s*(?:warnings|passes|short test summary)/i.test(line))
    .slice(-8)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function extractTestId(value: string): string | null {
  const text = String(value ?? '');
  return (
    /(?:FAILED\s+)?(?:\.\.\/)?tests?\/([^\s:]+::[^\s:]+)/i.exec(text)?.[1] ??
    /(?:FAILED\s+)?([A-Za-z0-9_.-]+\.py::[^\s:]+)/i.exec(text)?.[1] ??
    null
  );
}
