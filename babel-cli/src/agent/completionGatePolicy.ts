/**
 * Completion honesty policy — when execute work is "done enough" to finish.
 * Pure helpers; no I/O.
 */

import { isSuccessfulDirectMutation, isVerifierAttemptTool } from './mutationTools.js';
import { getChatTaskTune, isStrictVerification, type ChatTaskClass, type VerificationPolicy } from '../config/chatTaskClass.js';
import { buildGateRejectionMessage, hasSubAgentWrites } from './chatEngineCriticBudget.js';

/**
 * Heuristic: is this command likely a real test/verification run?
 * Returns false for obviously non-test commands (shell builtins, file ops).
 * Defaults to true for unknown commands (be generous — don't block legitimate
 * but unusual commands).
 *
 * Pure function; no I/O.
 *
 * Note: B1 shell junk (`del`, `echo`, …) is rejected here. B2 agent-owned
 * ad-hoc scripts (`_verify*.py`) are still "likely" verifiers for logging
 * but fail {@link isAuthoritativeVerifierCommand} used by honesty gates.
 */
export function isLikelyVerifierCommand(command: string | null | undefined): boolean {
  if (command == null) return false;
  const trimmed = command.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();

  // Known verifier test commands — check first so they beat any coincidental
  // prefix match against the non-verifier list below.
  const verifierPrefixes = [
    'npm run test',
    'npm test',
    'python -m pytest',
    'python -m unittest',
    'python -c',
    'python3 -c',
    'python3 -m pytest',
    'python3 -m unittest',
    'node -e',
    'pytest',
    'cargo test',
    'go test',
    'make test',
    'jest',
    'mocha',
    'npx jest',
    'deno test',
    'bun test',
    'ctest',
    'dotnet test',
    'rake test',
    'rspec',
    'pdm run',
    'poetry run',
    'tox',
    'nox',
  ];

  for (const prefix of verifierPrefixes) {
    if (lower.startsWith(prefix)) return true;
  }

  // Clearly NOT a verifier — shell builtins, file operations, etc.
  const nonVerifierRe =
    /^(?:del|rm|echo|ls|cat|type|dir|cd|pwd|cp|mv|mkdir|rmdir|cls|clear|set)(?:\s|$)/;
  if (nonVerifierRe.test(lower)) return false;

  // Default: unsure → assume it IS a verifier (don't block legitimate
  // unusual commands).
  return true;
}

/**
 * B2: agent-written ad-hoc check scripts that must not solely green completion.
 *
 * Matches A03-class patterns such as `python _verify_fix.py`,
 * `python _test_qdp_fix.py`, or bare `_verify_fix.py` — typically created
 * mid-session under underscore-prefixed names rather than project/dataset tests.
 *
 * Pure function; no I/O.
 */
export function isAgentOwnedAdHocVerifier(command: string | null | undefined): boolean {
  if (command == null) return false;
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Basename with leading underscore used as a throwaway harness script.
  // Examples: _verify_fix.py, _test_qdp_fix.py, ./_check_foo.js
  const agentScriptRe =
    /(?:^|[\s"'`/\\])(_(?:verify|test|check)[^/\\s"'`]*\.(?:py|js|mjs|cjs|ts|tsx|sh|ps1|bat|cmd))\b/i;
  if (agentScriptRe.test(trimmed)) return true;

  // `python path/to/_verify_fix.py` without quotes still matched above via / or \
  // Also catch bare underscore scripts as the sole token.
  if (/^[_./\\-]*(?:_verify|_test_|_check_)[^/\\s]*\.(?:py|js|mjs|cjs|ts|sh)\b/i.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * B2: command is a real test runner **and** not an agent-owned ad-hoc script.
 * Use for completion honesty gates and lastVerifierReceipt capture.
 */
export function isAuthoritativeVerifierCommand(
  command: string | null | undefined,
): boolean {
  if (!isLikelyVerifierCommand(command)) return false;
  if (isAgentOwnedAdHocVerifier(command)) return false;
  return true;
}

export type VerifierReceipt = {
  command: string;
  exit_code: number;
  summary: string;
};

export type GateToolLogEntry = {
  tool: string;
  target: string;
  detail?: string;
  error?: string;
  exit_code?: number;
};

/**
 * Task text explicitly asks to run tests / verify before complete.
 */
export function taskAsksForVerifier(task: string): boolean {
  return /\b(run|execute)\s+(npm\s+test|pytest|tests?|the\s+test)\s+(before|after|when|to\s+verify)/i.test(
    task,
  ) || /\b(run\s+tests?|verify\s+(with|via)\s+tests?|before\s+completing)\b/i.test(task);
}

/** Last local verifier attempt exited 0. */
export function hasGreenVerifierReceipt(
  receipt: VerifierReceipt | null | undefined,
): boolean {
  return receipt != null && receipt.exit_code === 0;
}

/**
 * Whether this execute completion requires a green local verifier.
 * True when policy is 'strict' OR task text explicitly asks for verification.
 *
 * @deprecated Prefer resolveVerificationPolicy + evaluateExecuteCompletionHonesty
 * for gate decisions. This helper remains for callers that only need the binary
 * "is green required?" question (diffCritic, chatEngineCriticBudget).
 */
export function requiresGreenVerifier(opts: {
  requireGreenVerifierClass: boolean;
  task: string;
}): boolean {
  return opts.requireGreenVerifierClass || taskAsksForVerifier(opts.task);
}

/**
 * Resolve the effective verification policy for a completion.
 * Task-class policy, escalated to 'strict' when the task text explicitly
 * asks for verification (user-facing contract).
 */
export function resolveVerificationPolicy(opts: {
  policy: VerificationPolicy;
  task: string;
}): VerificationPolicy {
  if (opts.policy === 'strict') return 'strict';
  if (taskAsksForVerifier(opts.task)) return 'strict';
  return opts.policy;
}

export type CompletionGateRejectReason =
  | 'no_writes'
  | 'verifier_missing'
  | 'verifier_red'
  | null;

/**
 * Evaluate write + verification rules for execute completion.
 *
 * Policy semantics:
 * - none:     any write allows completion (no verification check)
 * - required: must have a verifier receipt or attempt in log;
 *             non-zero exit warns but still allows (the user sees it)
 * - strict:   must have green verifier (exit 0); missing/red rejects
 */
export function evaluateExecuteCompletionHonesty(opts: {
  hasWrite: boolean;
  policy: VerificationPolicy;
  lastVerifierReceipt: VerifierReceipt | null | undefined;
  toolCallLog: GateToolLogEntry[];
}): { allow: boolean; reason: CompletionGateRejectReason } {
  if (!opts.hasWrite) {
    return { allow: false, reason: 'no_writes' };
  }
  if (opts.policy === 'none') {
    return { allow: true, reason: null };
  }

  // Both 'required' and 'strict' need at least a verifier attempt.
  const hasReceipt = opts.lastVerifierReceipt != null;

  // B1/B2: Verifier-command validation — reject receipts that are shell junk
  // (del/echo) or agent-owned ad-hoc scripts (_verify*.py). Honesty requires
  // an authoritative project/dataset-style verifier command.
  const hasRealReceipt =
    hasReceipt && isAuthoritativeVerifierCommand(opts.lastVerifierReceipt!.command);

  const greenInLog = opts.toolCallLog.some(
    (e) =>
      isVerifierAttemptTool(e.tool) &&
      e.error !== 'blocked' &&
      e.error !== 'error' &&
      (e as { exit_code?: number }).exit_code === 0,
  );
  // B1/B2: A log entry with a non-authoritative command does NOT satisfy the
  // verifier requirement even if the tool name matches and exit is 0.
  const hasRealGreenInLog = opts.toolCallLog.some(
    (e) =>
      isVerifierAttemptTool(e.tool) &&
      e.error !== 'blocked' &&
      e.error !== 'error' &&
      (e as { exit_code?: number }).exit_code === 0 &&
      isAuthoritativeVerifierCommand(e.target),
  );

  if (!hasRealReceipt && !hasRealGreenInLog) {
    return { allow: false, reason: 'verifier_missing' };
  }

  // 'strict' blocks on red verifier; 'required' lets it through with a warning.
  if (opts.policy === 'strict') {
    if (hasRealReceipt && opts.lastVerifierReceipt!.exit_code !== 0) {
      return { allow: false, reason: 'verifier_red' };
    }
    // No real receipt but real green in log: allow (verifier ran somewhere
    // with a real command and was green)
    if (!hasRealReceipt) {
      return { allow: true, reason: null };
    }
  }

  // 'required' with a receipt: allow regardless of exit code — the user
  // sees the result in the TUI and decides.
  return { allow: true, reason: null };
}

export function buildGreenVerifierRejectionMessage(
  reason: CompletionGateRejectReason,
  receipt: VerifierReceipt | null | undefined,
  projectTestCommands?: string[],
  strikeCount?: number,
): string {
  const cmdHint =
    projectTestCommands && projectTestCommands.length > 0
      ? `\nProject test commands: ${projectTestCommands.join(', ')}.`
      : '';

  // Strike-aware escalation: after multiple consecutive rejections the model
  // needs a more direct hint about what is wrong with its approach.
  const isStrike = strikeCount != null && strikeCount >= 2;
  const preamble = isStrike
    ? `This is rejection #${strikeCount}. Your previous verification attempts were not valid test runs.${
        strikeCount >= 3 ? ' FINAL ATTEMPT before the task is blocked.' : ''
      } `
    : '';

  // Escalation warning when strikes accumulate toward the auto-block threshold.
  const strikeEscalation = isStrike
    ? `After ${strikeCount} gate rejections, your next completion attempt will be auto-blocked. You MUST run and pass the verifier before completing.`
    : '';

  if (reason === 'verifier_red' && receipt) {
    const parts = [
      preamble,
      `COMPLETION_GATE_REJECTED: verifier_red (exit code ${receipt.exit_code})`,
      `Your tests failed. Fix the code until tests pass, then try completing again.`,
      `Gate check: last verifier failed (exit_code=${receipt.exit_code}).`,
      `command: ${receipt.command}`,
      isStrike
        ? 'Run the project\'s actual test command. Do NOT use shell utilities (del, echo, ls) or agent-owned scripts (_verify*.py, _test_*.py) as verification.'
        : 'You may not complete until the project verifier exits 0.',
      'Fix the failure (or adjust the test command if wrong), re-run the verifier, then finish.',
      'Do not invent a one-off script as the sole proof when repo tests exist.',
      strikeEscalation,
    ];
    if (cmdHint) parts.push(cmdHint);
    return parts.filter(Boolean).join(' ');
  }

  // verifier_missing (includes B2: agent-owned _verify*.py is non-authoritative)
  const parts = [preamble];
  if (isStrike) {
    parts.push(
      'Gate check: file changes exist but no valid verifier attempt was made.',
      'Run the project\'s actual test command. Do NOT use shell utilities (del, echo, ls) or agent-owned scripts (_verify*.py, _test_*.py) as the sole verification.',
    );
    parts.push('A missing verifier is not completion.');
    if (cmdHint) parts.push(cmdHint);
    if (strikeEscalation) parts.push(strikeEscalation);
  } else {
    parts.push(`COMPLETION_GATE_REJECTED: verifier_missing`);
    parts.push(`You claimed completion but never ran a real project/dataset test.`);
    if (projectTestCommands && projectTestCommands.length > 0) {
      parts.push(
        `Run these commands to verify your fix:\n  ${projectTestCommands.join('\n  ')}`,
        `Then try completing again.`,
      );
    } else {
      parts.push(
        `Discover the test runner (pytest, npm test, etc.) and run the relevant tests.`,
      );
    }
    parts.push(
      'A missing verifier is not completion. Agent-owned scripts like _verify*.py or _test_*.py do not count.',
    );
    if (cmdHint) parts.push(cmdHint);
  }
  return parts.filter(Boolean).join(' ');
}

/**
 * Build a targeted rejection message for when the gate rejects specifically
 * because no verifier was run (verifier_missing). Separates this concern from
 * the general rejection message used by buildGreenVerifierRejectionMessage.
 *
 * When projectTestCommands are available they are listed as runnable commands;
 * otherwise a generic hint about discovering the test runner is given.
 * Optional strikeCount adds escalation language.
 */
export function buildVerifierMissingRejectionMessage(
  projectTestCommands?: string[],
  strikeCount?: number,
): string {
  const parts: string[] = [
    `COMPLETION_GATE_REJECTED: verifier_missing`,
    `You claimed completion but never ran a real test.`,
  ];

  if (projectTestCommands && projectTestCommands.length > 0) {
    parts.push(
      `Run these commands to verify your fix:\n  ${projectTestCommands.join('\n  ')}`,
      `Then try completing again.`,
    );
  } else {
    parts.push(
      `Discover the test runner (pytest, npm test, etc.) and run the relevant tests.`,
    );
  }

  if (strikeCount != null && strikeCount >= 2) {
    parts.push(
      `After ${strikeCount} gate rejections, your next completion attempt will be auto-blocked. You MUST run and pass the verifier before completing.`,
    );
  }

  return parts.join(' ');
}

/** Session has successful direct mutations or sub-agent changes. */
export function logHasSuccessfulWrite(
  toolCallLog: GateToolLogEntry[],
  hasSubAgentWrites: (log: GateToolLogEntry[]) => boolean,
): boolean {
  return (
    toolCallLog.some((e) => isSuccessfulDirectMutation(e.tool, e.error)) ||
    hasSubAgentWrites(toolCallLog)
  );
}

/** Shared BLOCKED answer when completion has no writes and zero tools this turn. */
export const AUTO_CONTINUE_REFUSAL_MSG = [
  'BLOCKED: Completion rejected (no writes) and this turn had zero tool calls.',
  'Auto-continue refused — the model produced text without using any tools.',
  'The task may be impossible or the model does not understand how to proceed.',
].join('\n');

export function buildAutoContinueBlockedReport(): {
  schema_version: 1;
  status: 'BLOCKED';
  reason: string;
  missing: string;
  checked: Array<{ action: string; target: string; finding: string }>;
} {
  return {
    schema_version: 1,
    status: 'BLOCKED',
    reason: 'Auto-continue refused: completion rejected with zero tool calls this turn',
    missing: 'No tools were used — model produced text only',
    checked: [
      {
        action: 'auto_continue_refusal',
        target: 'zero_tool_calls',
        finding:
          'Turn produced a completion without any tool calls; auto-continue refuses to restart',
      },
    ],
  };
}

/**
 * Decide how to handle a completion-gate reject (shared by submit + stream paths).
 *
 * Headless/CI hard-block (product lock 2026-07-12):
 * - `hardGate` is true when BABEL_HEADLESS=1, CI=1, or non-TTY.
 * - Under hardGate, both `strict` and `required` policies reject-continue then
 *   hard-BLOCK after max strikes (no soft-allow of missing authoritative verifier).
 * - Interactive (hardGate false): `required` may soft-allow; `strict` still enforces.
 */
export type GateRejectPlan =
  | { kind: 'auto_continue_block' }
  | { kind: 'reject_continue'; gateStrikesAfter: number; useGreenMessage: boolean }
  | { kind: 'blocked'; reason: string }
  | { kind: 'soft_allow'; gateStrikesAfter: number };

/** Whether this reject must never soft-allow through (headless required/strict or any strict). */
export function shouldHardBlockVerifierHonesty(opts: {
  policy: VerificationPolicy;
  hardGate: boolean;
}): boolean {
  if (opts.policy === 'strict') return true;
  // P3 product lock: required + headless/CI hard-blocks missing authoritative verifier
  if (opts.policy === 'required' && opts.hardGate) return true;
  return false;
}

export function planCompletionGateReject(opts: {
  hasWrites: boolean;
  policy: VerificationPolicy;
  hardGate: boolean;
  hadToolCallsThisTurn: boolean;
  gateStrikes: number;
  maxGateStrikes: number;
}): GateRejectPlan {
  const enforceHard = shouldHardBlockVerifierHonesty({
    policy: opts.policy,
    hardGate: opts.hardGate,
  });

  if (!opts.hasWrites) {
    if (!opts.hadToolCallsThisTurn) {
      return { kind: 'auto_continue_block' };
    }
    const next = opts.gateStrikes + 1;
    if (opts.hardGate && next <= opts.maxGateStrikes) {
      return {
        kind: 'reject_continue',
        gateStrikesAfter: next,
        useGreenMessage: false,
      };
    }
    // Bug B fix: hardGate + zero writes after max strikes → BLOCKED (not soft_allow).
    // Headless/CI must never soft-allow empty-patch completions.
    if (opts.hardGate) {
      return {
        kind: 'blocked',
        reason: [
          `Gate blocked after ${next} consecutive completion rejections with no successful file mutations.`,
          'The agent made tool calls but produced zero successful file writes.',
          'Headless/CI hard-block: will not soft-allow without file mutations.',
        ].join(' '),
      };
    }
    return { kind: 'soft_allow', gateStrikesAfter: 0 };
  }

  // Has writes but honesty failed (verifier missing/red under strict, missing under required, …)
  if (enforceHard && opts.gateStrikes >= opts.maxGateStrikes) {
    return {
      kind: 'blocked',
      reason: [
        `Gate blocked after ${opts.gateStrikes + 1} consecutive completion rejections.`,
        'The authoritative verifier was missing or failed each time.',
        opts.hardGate
          ? 'Headless/CI hard-block: will not soft-allow without a project/dataset verifier.'
          : 'The model could not produce a passing verifier — task may require human guidance.',
      ].join(' '),
    };
  }

  if (enforceHard || opts.gateStrikes < opts.maxGateStrikes) {
    const next = opts.gateStrikes + 1;
    if (enforceHard || opts.hardGate) {
      return {
        kind: 'reject_continue',
        gateStrikesAfter: next,
        useGreenMessage: true,
      };
    }
    // Interactive + required (not hard-enforced): soft-allow so humans can finish
    return { kind: 'soft_allow', gateStrikesAfter: 0 };
  }

  // Interactive non-strict after max strikes: allow through
  return { kind: 'soft_allow', gateStrikesAfter: 0 };
}

/** Full evaluateCompletionGate for ChatEngine (execute + verification policy). */
export function evaluateCompletionGateForEngine(opts: {
  turnType: string;
  taskIntent: 'execute' | 'explain';
  task: string;
  taskClass: ChatTaskClass;
  toolCallLog: GateToolLogEntry[];
  lastVerifierReceipt: VerifierReceipt | null | undefined;
}): 'allow' | 'reject' {
  if (opts.taskIntent !== 'execute') return 'allow';
  if (opts.turnType !== 'completion') return 'allow';

  const log = opts.toolCallLog;
  const hasWrite =
    log.some((e) => isSuccessfulDirectMutation(e.tool, e.error)) ||
    hasSubAgentWrites(log);
  const tune = getChatTaskTune(opts.taskClass);
  const policy = resolveVerificationPolicy({
    policy: tune.verificationPolicy,
    task: opts.task,
  });
  const honesty = evaluateExecuteCompletionHonesty({
    hasWrite,
    policy,
    lastVerifierReceipt: opts.lastVerifierReceipt,
    toolCallLog: log,
  });
  if (!honesty.allow) return 'reject';
  // For 'required' policy: also check that when task asks for verifier,
  // the agent actually ran one (even if the receipt was non-zero and allowed).
  if (policy !== 'strict' && taskAsksForVerifier(opts.task)) {
    if (!log.some((e) => isVerifierAttemptTool(e.tool))) return 'reject';
  }
  return 'allow';
}

export function buildGateRejectUserMessageForEngine(opts: {
  task: string;
  taskClass: ChatTaskClass;
  toolCallLog: GateToolLogEntry[];
  lastVerifierReceipt: VerifierReceipt | null | undefined;
  hasAnyWrites: boolean;
  projectTestCommands?: string[];
  gateStrikes?: number;
}): string {
  const tune = getChatTaskTune(opts.taskClass);
  const policy = resolveVerificationPolicy({
    policy: tune.verificationPolicy,
    task: opts.task,
  });
  const log = opts.toolCallLog;
  if (!opts.hasAnyWrites) {
    return buildGateRejectionMessage(log);
  }
  const honesty = evaluateExecuteCompletionHonesty({
    hasWrite: true,
    policy,
    lastVerifierReceipt: opts.lastVerifierReceipt,
    toolCallLog: log,
  });
  if (honesty.reason === 'verifier_missing' || honesty.reason === 'verifier_red') {
    return buildGreenVerifierRejectionMessage(
      honesty.reason,
      opts.lastVerifierReceipt,
      opts.projectTestCommands,
      opts.gateStrikes, // strikeCount
    );
  }
  return buildGateRejectionMessage(log);
}
