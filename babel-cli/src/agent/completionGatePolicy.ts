/**
 * Completion honesty policy — when execute work is "done enough" to finish.
 * Pure helpers; no I/O.
 */

import { isSuccessfulDirectMutation, isVerifierAttemptTool } from './mutationTools.js';
import { getChatTaskTune, isStrictVerification, type ChatTaskClass, type VerificationPolicy } from '../config/chatTaskClass.js';
import {
  buildGateRejectionMessage,
  hasAnyWrites as hasLoggedWrites,
  hasSubAgentWrites,
} from './chatEngineCriticBudget.js';
import type { StructuredVerifierCommand, VerifierAuthoritySource } from '../executor/contracts.js';
import { extractRequiredVerifierCommandsFromTask } from '../pipeline/planVerifierInjection.js';
import { extractVerifierCommand } from './chatEngineVerifierSession.js';
import { analyzeVerifierIdentity, satisfiesVerifierRequirement } from '../services/verifierIdentity.js';
import {
  buildVerifierReceiptV2,
  evaluateVerifierPromotion,
  type VerifierScope,
} from './verifierKernel.js';

/** Preserve ledger scope; never force targeted → full_suite (H5 live gate). */
export function receiptScopeFromLedgerEntry(r: unknown): VerifierScope {
  if (r && typeof r === 'object' && 'scope' in r) {
    const s = String((r as { scope?: unknown }).scope ?? '');
    if (
      s === 'full_suite' ||
      s === 'targeted' ||
      s === 'smoke' ||
      s === 'property' ||
      s === 'security'
    ) {
      return s;
    }
  }
  // Missing scope is never promoted from command spelling.
  return 'unknown';
}

/**
 * Derive adversarial promotion signals from ledger + tool log (not only flag injection).
 * Specialized detectors may also pass opts.adversarial; these are mechanical heuristics.
 */
export function deriveAdversarialSignals(opts: {
  toolCallLog: readonly { tool: string; target?: string; exit_code?: number }[];
  receipts: readonly {
    exit_code?: number;
    tests_skipped?: number;
    tests_total?: number;
    tests_failed?: number;
    summary?: string;
  }[];
  hasWrite: boolean;
}): {
  tests_deleted?: boolean;
  shortcut_noop?: boolean;
  hardcoded_fixture?: boolean;
  flaky_green?: boolean;
  baseline_failing?: boolean;
  verifier_def_tampered?: boolean;
} {
  const signals: {
    tests_deleted?: boolean;
    shortcut_noop?: boolean;
    hardcoded_fixture?: boolean;
    flaky_green?: boolean;
    baseline_failing?: boolean;
    verifier_def_tampered?: boolean;
  } = {};

  for (const r of opts.receipts) {
    if (
      typeof r.tests_skipped === 'number' &&
      typeof r.tests_total === 'number' &&
      r.tests_total > 0 &&
      r.tests_skipped >= r.tests_total &&
      (r.tests_failed ?? 0) === 0 &&
      (r.exit_code ?? 1) === 0
    ) {
      signals.tests_deleted = true;
    }
    const summary = String(r.summary ?? '');
    if (/HARDCODED_FIXTURE|fixture.?green|always.?pass/i.test(summary)) {
      signals.hardcoded_fixture = true;
    }
    if (/VERIFIER_DEF_TAMPERED|tampered.?verifier/i.test(summary)) {
      signals.verifier_def_tampered = true;
    }
  }

  // Shortcut/no-op: writes claimed but every write target is empty / noop marker
  if (opts.hasWrite) {
    const writes = opts.toolCallLog.filter(
      (e) => e.tool === 'write_file' || e.tool === 'str_replace' || e.tool === 'apply_patch',
    );
    if (
      writes.length > 0 &&
      writes.every(
        (w) =>
          !w.target ||
          /noop|shortcut|empty/i.test(String(w.target)) ||
          w.exit_code === 0 && String(w.target).endsWith('.noop'),
      )
    ) {
      // Only flag when all writes look like deliberate shortcuts
      if (writes.some((w) => /noop|shortcut|\.noop$/i.test(String(w.target ?? '')))) {
        signals.shortcut_noop = true;
      }
    }
  }

  return signals;
}

/** Known project/dataset test runners (prefixes; case-insensitive match on trimmed cmd). */
const AUTHORITATIVE_VERIFIER_PREFIXES = [
  'npm run test',
  'npm test',
  'npx jest',
  'npx vitest',
  'python -m pytest',
  'python -m unittest',
  'python3 -m pytest',
  'python3 -m unittest',
  'py -m pytest',
  'py -m unittest',
  'pytest',
  'cargo test',
  'go test',
  'make test',
  'jest',
  'mocha',
  'vitest',
  'deno test',
  'bun test',
  'ctest',
  'dotnet test',
  'rake test',
  'rspec',
  'tox',
  'nox',
  'poetry run pytest',
  'poetry run test',
  'pdm run pytest',
  'pdm run test',
] as const;

/**
 * Package-manager / env-bootstrap commands that must never green completion.
 * Evidence (SWE-Pro 4a5d reval 2026-08-01): `pip install requests` exit 0 became
 * lastVerifierReceipt / completion_verification pass under default-true likely-verifier.
 *
 * Pure function; no I/O.
 */
export function isPackageManagerInstallCommand(
  command: string | null | undefined,
): boolean {
  if (command == null) return false;
  const lower = command.trim().toLowerCase();
  if (!lower) return false;

  // pip / python -m pip / uv pip
  if (
    /^(?:python3?|py)\s+-m\s+pip\s+install\b/.test(lower) ||
    /^(?:pip3?|pipx)\s+install\b/.test(lower) ||
    /^uv\s+pip\s+install\b/.test(lower) ||
    /^uv\s+add\b/.test(lower)
  ) {
    return true;
  }
  // npm / yarn / pnpm / bun install or add (not npm test)
  if (
    /^(?:npm|yarn|pnpm|bun)\s+(?:install|add|i)\b/.test(lower) ||
    /^npm\s+ci\b/.test(lower)
  ) {
    return true;
  }
  if (/^(?:cargo\s+add|go\s+get|composer\s+install|gem\s+install|bundle\s+install)\b/.test(lower)) {
    return true;
  }
  return false;
}

/**
 * Heuristic: is this command likely a verification *attempt* (for logging / counters)?
 * Returns false for shell junk and package installs.
 * Defaults to true for unknown commands so unusual project scripts still log as attempts.
 *
 * Pure function; no I/O.
 *
 * Note: B1 shell junk (`del`, `echo`, …) is rejected here. B2 agent-owned
 * ad-hoc scripts (`_verify*.py`) are still "likely" for logging but fail
 * {@link isAuthoritativeVerifierCommand} used by honesty gates.
 * Package installs are neither likely nor authoritative.
 */
export function isLikelyVerifierCommand(command: string | null | undefined): boolean {
  if (command == null) return false;
  const trimmed = command.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();

  if (isPackageManagerInstallCommand(trimmed)) return false;

  // Known verifier / probe prefixes (includes inline probes — still "likely" for logging)
  const verifierPrefixes = [
    ...AUTHORITATIVE_VERIFIER_PREFIXES,
    'python -c',
    'python3 -c',
    'py -c',
    'node -e',
    'node --eval',
    'pdm run',
    'poetry run',
  ];

  for (const prefix of verifierPrefixes) {
    if (lower.startsWith(prefix)) return true;
  }

  // Clearly NOT a verifier — shell builtins, file operations, etc.
  const nonVerifierRe =
    /^(?:del|rm|echo|ls|cat|type|dir|cd|pwd|cp|mv|mkdir|rmdir|cls|clear|set)(?:\s|$)/;
  if (nonVerifierRe.test(lower)) return false;

  // Default: unsure → assume it IS a verifier attempt (logging only).
  // Honesty uses {@link isAuthoritativeVerifierCommand} which is deny-by-default.
  return true;
}

/**
 * True when command matches the hard allowlist of project/dataset test runners,
 * or an optional session-bound authoritative command (exact or prefix match).
 */
export function matchesAuthoritativeVerifierAllowlist(
  command: string,
  boundCommands?: readonly string[] | null,
): boolean {
  const lower = command.trim().toLowerCase();
  if (!lower) return false;

  for (const prefix of AUTHORITATIVE_VERIFIER_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }

  // python path/to/test_*.py or …/tests/… (not agent-owned _test_* — filtered later)
  if (
    /^(?:python3?|py)\s+(?:["']?)(?:\.\/)?(?:[\w./\\-]*\/)?(?:tests?\/|test_)[\w./\\-]+\.py\b/.test(
      lower,
    )
  ) {
    return true;
  }

  if (boundCommands && boundCommands.length > 0) {
    for (const bound of boundCommands) {
      const b = bound.trim().toLowerCase();
      if (!b) continue;
      if (lower === b || lower.startsWith(`${b} `) || lower.startsWith(b)) {
        return true;
      }
    }
  }

  return false;
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
 * Inline one-liners / simulated harnesses that must not solely green completion.
 *
 * Evidence (SWE-Bench Pro pilot / general_swe):
 * - `python -c "print('hello')"` was treated as green authoritative verify
 * - `python -c` re-implementing the unit under test with dataclasses (no project import)
 *   passed exit checks while real project tests never ran
 *
 * Keep these as {@link isLikelyVerifierCommand} so they still log as verify attempts,
 * but they are **not** authoritative for honesty gates.
 *
 * Pure function; no I/O.
 */
export function isInlineProbeVerifier(command: string | null | undefined): boolean {
  if (command == null) return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();

  // python -c / python3 -c / node -e / node --eval  → inline probes
  if (
    /^(?:python3?|py)\s+-c\b/.test(lower) ||
    /^node\s+(?:-e|--eval)\b/.test(lower)
  ) {
    return true;
  }

  // Toy print-only probes even if wrapped (shell -c 'python -c print...')
  if (
    /\bpython3?\s+-c\s+["']?\s*print\s*\(\s*['"]hello['"]\s*\)/i.test(trimmed) ||
    /\bnode\s+-e\s+["']?\s*console\.log\s*\(\s*['"]hello['"]\s*\)/i.test(trimmed)
  ) {
    return true;
  }

  return false;
}

/** Detect shell composition outside quoted verifier arguments. */
export function hasVerifierShellComposition(command: string | null | undefined): boolean {
  if (command == null) return false;
  const trimmed = command.trim();
  if (!trimmed) return false;

  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    const next = trimmed[index + 1] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      continue;
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }
    if (quote !== null) continue;
    if (char === ';' || char === '|' || char === '>' || char === '<' || char === '\n' || char === '\r') return true;
    if (char === '&' && next === '&') return true;
    if (char === '$' && next === '(') return true;
    if (char === '`') return true;
  }

  const lower = trimmed.toLowerCase();
  return /(?:^|\s)(?:cmd(?:\.exe)?\s+\/c|powershell(?:\.exe)?\s+-(?:command|encodedcommand)|pwsh(?:\.exe)?\s+-(?:command|encodedcommand))(?:\s|$)/.test(lower)
    || /(?:^|\s)(?:invoke-expression|iex)(?:\s|$)/.test(lower);
}

/** Parse a simple verifier invocation into a structured executable/argv record. */
export function parseStructuredVerifierCommand(
  command: string,
  options?: { verifierId?: string; authoritySource?: VerifierAuthoritySource },
): StructuredVerifierCommand | null {
  const trimmed = command.trim();
  if (!trimmed || hasVerifierShellComposition(trimmed)) return null;
  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) =>
    token.replace(/^("|')|("|')$/g, ''),
  );
  if (!tokens || tokens.length === 0) return null;
  return {
    verifierId: options?.verifierId ?? `verifier:${tokens[0]!.toLowerCase()}`,
    executable: tokens[0]!,
    args: tokens.slice(1),
    authoritySource: options?.authoritySource ?? 'unknown',
    displayCommand: trimmed,
  };
}

/**
 * B2 / W1 honesty: command is an allowlisted project/dataset test runner
 * (or session-bound authoritative command), and not agent-owned ad-hoc,
 * inline probe, package install, or shell junk.
 *
 * **Deny-by-default** for unknown commands — the pre-W1 path treated unknown
 * commands as authoritative via {@link isLikelyVerifierCommand}'s default-true,
 * which let `pip install requests` green completion (SWE-Pro 4a5d).
 *
 * Use for completion honesty gates and lastVerifierReceipt capture.
 *
 * @param boundCommands Optional session/dataset commands (e.g. fail_to_pass pytest
 *   nodes) that are authoritative even if not on the global prefix list.
 */
export function isAuthoritativeVerifierCommand(
  command: string | null | undefined,
  boundCommands?: readonly string[] | null,
): boolean {
  if (command == null) return false;
  const trimmed = command.trim();
  if (!trimmed) return false;

  if (isPackageManagerInstallCommand(trimmed)) return false;
  if (isAgentOwnedAdHocVerifier(trimmed)) return false;
  if (isInlineProbeVerifier(trimmed)) return false;
  if (hasVerifierShellComposition(trimmed)) return false;

  // Shell junk is never authoritative
  const lower = trimmed.toLowerCase();
  if (/^(?:del|rm|echo|ls|cat|type|dir|cd|pwd|cp|mv|mkdir|rmdir|cls|clear|set)(?:\s|$)/.test(lower)) {
    return false;
  }

  // Deny-by-default: only allowlisted runners or session-bound commands
  return matchesAuthoritativeVerifierAllowlist(trimmed, boundCommands);
}

export type VerifierReceipt = {
  command: string;
  exit_code: number;
  exitCode?: number;
  summary: string;
  stale?: boolean;
  authority?: boolean;
  /** Why the controller marked the receipt stale (mutation flag or revision recheck). */
  staleReason?: string;
  receiptId?: string;
  verifierId?: string;
  /** Workspace identity captured when the verifier ran (H7). */
  boundRevision?: {
    gitCommitHash: string | null;
    compositeTreeHash: string;
    fileHashes: Record<string, string>;
    capturedAt: number;
  };
  verifier_id?: string;
  authority_source?: VerifierAuthoritySource;
  authoritySource?: VerifierAuthoritySource;
  capturedAt?: number;
  argv?: string[];
};

export type GateToolLogEntry = {
  tool: string;
  target: string;
  detail?: string;
  error?: string;
  exit_code?: number;
  mutation_paths?: string[];
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
  | 'verifier_stale'
  | 'verifier_scope'
  | 'verifier_receipt_invalid'
  | null;

/**
 * Resolve required verifier commands for Chat honesty scope checks.
 * Explicit list wins; else task "Verifier commands:" / "Run X before completing";
 * else when the task asks for verification, project-discovered test commands.
 */
export function resolveHonestyRequiredVerifiers(opts: {
  task: string;
  projectTestCommands?: readonly string[] | null;
  requiredVerifierCommands?: readonly string[] | null;
}): string[] {
  if (opts.requiredVerifierCommands && opts.requiredVerifierCommands.length > 0) {
    return [...opts.requiredVerifierCommands];
  }
  const fromTask = extractRequiredVerifierCommandsFromTask(opts.task);
  if (fromTask.length > 0) return fromTask;
  const single = extractVerifierCommand(opts.task);
  if (single) return [single];
  if (
    taskAsksForVerifier(opts.task) &&
    opts.projectTestCommands &&
    opts.projectTestCommands.length > 0
  ) {
    return opts.projectTestCommands.map((c) => c.trim()).filter(Boolean);
  }
  return [];
}

/** Whether an actual command satisfies any required verifier (directional identity). */
export function commandSatisfiesRequiredVerifierScope(
  actualCommand: string,
  requiredVerifierCommands: readonly string[] | null | undefined,
): boolean {
  if (!requiredVerifierCommands || requiredVerifierCommands.length === 0) return true;
  return requiredVerifierCommands.some((required) =>
    satisfiesVerifierRequirement(required, actualCommand),
  );
}

/** Whether all required verifiers are satisfied by actual executed commands (directional identity). */
export function areAllRequiredVerifiersSatisfied(
  requiredVerifierCommands: readonly string[] | null | undefined,
  actualCommands: readonly string[],
): boolean {
  if (!requiredVerifierCommands || requiredVerifierCommands.length === 0) return true;
  return requiredVerifierCommands.every((required) =>
    actualCommands.some((actual) => satisfiesVerifierRequirement(required, actual)),
  );
}

/**
 * Evaluate write + verification rules for execute completion.
 *
 * Policy semantics:
 * - none:     any write allows completion (no verification check)
 * - required: must have a verifier receipt or attempt in log;
 *             non-zero exit warns but still allows (the user sees it)
 * - strict:   must have green verifier (exit 0); missing/red rejects
 *
 * When `requiredVerifierCommands` is non-empty, authoritative greens that fail
 * structural scope (e.g. targeted run vs full-suite required) reject with
 * `verifier_scope`.
 */
export function evaluateExecuteCompletionHonesty(opts: {
  hasWrite: boolean;
  policy: VerificationPolicy;
  lastVerifierReceipt?: VerifierReceipt | import('../executor/contracts.js').ExecutorVerifierReceipt | null;
  toolCallLog: GateToolLogEntry[];
  /** Required full/targeted commands for structural scope (optional). */
  requiredVerifierCommands?: readonly string[] | null;
  /** Ledger of executed verifier receipts (optional). */
  executedVerifierLedger?: readonly VerifierReceipt[] | readonly import('../executor/contracts.js').ExecutorVerifierReceipt[] | null;
  /** Errors produced during evidence adaptation (optional). */
  verifierEvidenceErrors?: readonly string[] | null;
}): { allow: boolean; reason: CompletionGateRejectReason } {
  // Precedence 1: Receipt adaptation failures deterministically reject completion.
  if (opts.verifierEvidenceErrors && opts.verifierEvidenceErrors.length > 0) {
    return { allow: false, reason: 'verifier_receipt_invalid' };
  }

  if (!opts.hasWrite) {
    return { allow: false, reason: 'no_writes' };
  }
  if (opts.policy === 'none') {
    return { allow: true, reason: null };
  }

  const required = opts.requiredVerifierCommands ?? [];
  // Explicit presence, including [], selects canonical mode. In that mode the
  // tool log is never an authorization source.
  const hasExplicitLedger = opts.executedVerifierLedger !== undefined && opts.executedVerifierLedger !== null;
  const hasCanonicalEvidence = hasExplicitLedger || opts.lastVerifierReceipt != null;
  const canonicalReceipts = hasCanonicalEvidence
    ? deduplicateVerifierReceipts(
        hasExplicitLedger
          ? opts.executedVerifierLedger ?? []
          : opts.lastVerifierReceipt
            ? [opts.lastVerifierReceipt]
            : [],
      )
    : [];
  const authoritativeReceipts = canonicalReceipts.filter(isAuthoritativeReceipt);
  const legacyLogEntries = hasCanonicalEvidence
    ? []
    : opts.toolCallLog.filter(
        (entry) =>
          isVerifierAttemptTool(entry.tool) &&
          entry.error !== 'blocked' &&
          entry.error !== 'error' &&
          isAuthoritativeVerifierCommand(entry.target),
      );

  if (required.length === 0) {
    const attempts = hasCanonicalEvidence ? authoritativeReceipts : legacyLogEntries;
    const staleAttempts = attempts.filter((entry) => isStaleVerifierEvidence(entry));
    const activeAttempts = attempts.filter((entry) => !isStaleVerifierEvidence(entry));
    if (staleAttempts.length > 0) return { allow: false, reason: 'verifier_stale' };
    if (activeAttempts.length === 0) {
      return {
        allow: false,
        reason: staleAttempts.length > 0 ? 'verifier_stale' : 'verifier_missing',
      };
    }

    if (opts.policy === 'strict' && activeAttempts.some((entry) => verifierExitCode(entry) !== 0)) {
      return { allow: false, reason: 'verifier_red' };
    }
    return { allow: true, reason: null };
  }

  if (hasCanonicalEvidence && authoritativeReceipts.some((entry) => isStaleVerifierEvidence(entry))) {
    return { allow: false, reason: 'verifier_stale' };
  }

  let hasStaleRequirement = false;
  let hasRedRequirement = false;
  let hasMissingRequirement = false;
  let hasOutOfScopeAttempt = false;

  for (const requirement of required) {
    const matching = hasCanonicalEvidence
      ? authoritativeReceipts.filter((receipt) => satisfiesVerifierRequirement(requirement, receipt.command))
      : legacyLogEntries.filter((entry) => satisfiesVerifierRequirement(requirement, entry.target));
    const latest = matching.at(-1);

    if (!latest) {
      hasMissingRequirement = true;
      if ((hasCanonicalEvidence ? authoritativeReceipts : legacyLogEntries).length > 0) {
        hasOutOfScopeAttempt = true;
      }
      continue;
    }
    if (isStaleVerifierEvidence(latest)) {
      hasStaleRequirement = true;
      continue;
    }
    if (verifierExitCode(latest) !== 0) {
      hasRedRequirement = true;
    }
  }

  // Stable precedence: invalid adaptation → stale → red → missing/scope.
  if (hasStaleRequirement) return { allow: false, reason: 'verifier_stale' };
  if (opts.policy === 'strict' && hasRedRequirement) return { allow: false, reason: 'verifier_red' };
  if (hasMissingRequirement) {
    return {
      allow: false,
      reason: hasOutOfScopeAttempt ? 'verifier_scope' : 'verifier_missing',
    };
  }
  return { allow: true, reason: null };
}

type VerifierEvidence = VerifierReceipt | import('../executor/contracts.js').ExecutorVerifierReceipt;

function deduplicateVerifierReceipts(
  receipts: readonly VerifierEvidence[],
): VerifierEvidence[] {
  const byIdentity = new Map<string, VerifierEvidence>();
  for (const receipt of receipts) {
    const key = verifierIdentityKey(receipt.command);
    // Map insertion order is retained while assignment makes the latest
    // attempt authoritative for a structural identity.
    byIdentity.set(key, receipt);
  }
  return [...byIdentity.values()];
}

function verifierIdentityKey(command: string): string {
  const identity = analyzeVerifierIdentity(command);
  return identity?.identityKey ?? command.trim().replace(/\s+/g, ' ');
}

function isAuthoritativeReceipt(entry: VerifierEvidence): boolean {
  return entry.authority === true && isAuthoritativeVerifierCommand(entry.command);
}

function verifierExitCode(entry: VerifierEvidence | GateToolLogEntry): number {
  if ('exitCode' in entry && typeof entry.exitCode === 'number') return entry.exitCode;
  if ('exit_code' in entry && typeof entry.exit_code === 'number') return entry.exit_code;
  return Number.NaN;
}

function isStaleVerifierEvidence(entry: VerifierEvidence | GateToolLogEntry): boolean {
  return 'stale' in entry && entry.stale === true;
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

  const isStrike = strikeCount != null && strikeCount >= 2;
  const preamble = isStrike
    ? `This is rejection #${strikeCount}. Your previous verification attempts were not valid test runs.${
        strikeCount >= 3 ? ' FINAL ATTEMPT before the task is blocked.' : ''
      } `
    : '';

  const strikeEscalation = isStrike
    ? `After ${strikeCount} gate rejections, your next completion attempt will be auto-blocked. You MUST run and pass the verifier before completing.`
    : '';

  if (reason === 'verifier_receipt_invalid') {
    return [
      preamble,
      `COMPLETION_GATE_REJECTED: verifier_receipt_invalid`,
      `Verifier receipt evidence is missing required bound revision or authority metadata.`,
      `You must re-run an authoritative project test command before completing.`,
      strikeEscalation,
    ].filter(Boolean).join(' ');
  }

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

  if (reason === 'verifier_stale') {
    return [
      preamble,
      `COMPLETION_GATE_REJECTED: verifier_stale`,
      `Files were modified after the last successful verifier execution.`,
      `You must re-run the tests to prove the new changes are correct before completing.`,
      strikeEscalation,
    ].filter(Boolean).join(' ');
  }

  if (reason === 'verifier_scope') {
    return [
      preamble,
      `COMPLETION_GATE_REJECTED: verifier_scope`,
      `Your last verifier was too narrow (or the wrong runner) for the required suite.`,
      receipt
        ? `Last command: ${receipt.command}`
        : 'Last command: (none recorded).',
      'Run the full required project test command (not a single-file targeted run) before completing.',
      cmdHint,
      strikeEscalation,
    ]
      .filter(Boolean)
      .join(' ');
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
  projectTestCommands?: readonly string[] | null;
  requiredVerifierCommands?: readonly string[] | null;
  /** Canonical executed verifier ledger — when supplied, toolCallLog is not used for requirement satisfaction. */
  executedVerifierLedger?: readonly VerifierReceipt[] | readonly import('../executor/contracts.js').ExecutorVerifierReceipt[] | null;
  /** Adaptation errors from chat receipt → canonical receipt conversion. */
  verifierEvidenceErrors?: readonly string[] | null;
  /**
   * H5: live workspace revision hash at completion time.
   * Must NOT be taken from the receipt itself (that makes wrong_revision tautological).
   */
  currentWorkspaceRevisionHash?: string | null;
  /**
   * Optional explicit adversarial signals (specialized detectors / tests).
   * Live path also derives mechanical signals via deriveAdversarialSignals.
   */
  adversarial?: {
    tests_deleted?: boolean;
    shortcut_noop?: boolean;
    hardcoded_fixture?: boolean;
    flaky_green?: boolean;
    baseline_failing?: boolean;
    verifier_def_tampered?: boolean;
  };
}): 'allow' | 'reject' {
  if (opts.taskIntent !== 'execute') return 'allow';
  if (opts.turnType !== 'completion') return 'allow';

  const log = opts.toolCallLog;
  const hasWrite = hasLoggedWrites(log);
  const tune = getChatTaskTune(opts.taskClass);
  const policy = resolveVerificationPolicy({
    policy: tune.verificationPolicy,
    task: opts.task,
  });
  const requiredVerifierCommands = resolveHonestyRequiredVerifiers({
    task: opts.task,
    ...(opts.projectTestCommands !== undefined
      ? { projectTestCommands: opts.projectTestCommands }
      : {}),
    ...(opts.requiredVerifierCommands !== undefined
      ? { requiredVerifierCommands: opts.requiredVerifierCommands }
      : {}),
  });
  const honesty = evaluateExecuteCompletionHonesty({
    hasWrite,
    policy,
    lastVerifierReceipt: opts.lastVerifierReceipt ?? null,
    toolCallLog: log,
    requiredVerifierCommands,
    executedVerifierLedger: opts.executedVerifierLedger ?? null,
    verifierEvidenceErrors: opts.verifierEvidenceErrors ?? null,
  });
  if (!honesty.allow) return 'reject';
  // For 'required' policy: also check that when task asks for verifier,
  // the agent actually ran one (even if the receipt was non-zero and allowed).
  if (policy !== 'strict' && taskAsksForVerifier(opts.task)) {
    const hasCanonicalAttempt =
      opts.executedVerifierLedger !== undefined && opts.executedVerifierLedger !== null
        ? deduplicateVerifierReceipts(opts.executedVerifierLedger).some(isAuthoritativeReceipt)
        : opts.lastVerifierReceipt != null
          ? isAuthoritativeReceipt(opts.lastVerifierReceipt)
          : log.some((e) => isVerifierAttemptTool(e.tool));
    if (!hasCanonicalAttempt) return 'reject';
  }
  // H5: when mutating work requires verifiers, empty required plans cannot green.
  if (hasWrite && requiredVerifierCommands.length === 0 && policy === 'strict') {
    return 'reject';
  }
  if (hasWrite && requiredVerifierCommands.length > 0 && policy === 'strict') {
    const rawReceipts =
      opts.executedVerifierLedger !== undefined && opts.executedVerifierLedger !== null
        ? opts.executedVerifierLedger
        : opts.lastVerifierReceipt
          ? [opts.lastVerifierReceipt]
          : [];
    const receipts = rawReceipts.map((r, i) => {
      const cmd = 'command' in r ? String((r as { command?: string }).command ?? '') : '';
      const exit =
        'exitCode' in r
          ? Number((r as { exitCode?: number }).exitCode ?? 1)
          : 'exit_code' in r
            ? Number((r as { exit_code?: number }).exit_code ?? 1)
            : 1;
      const rev =
        'boundRevision' in r && (r as { boundRevision?: { compositeTreeHash?: string } }).boundRevision
          ? (r as { boundRevision: { compositeTreeHash?: string } }).boundRevision
          : { compositeTreeHash: '' };
      const stale = 'stale' in r ? Boolean((r as { stale?: boolean }).stale) : false;
      const scope = receiptScopeFromLedgerEntry(r);
      const summary = 'summary' in r ? String((r as { summary?: string }).summary ?? '') : '';
      const optCounts: {
        tests_total?: number;
        tests_skipped?: number;
        tests_failed?: number;
      } = {};
      if ('tests_total' in r && typeof (r as { tests_total?: unknown }).tests_total === 'number') {
        optCounts.tests_total = (r as { tests_total: number }).tests_total;
      }
      if (
        'tests_skipped' in r &&
        typeof (r as { tests_skipped?: unknown }).tests_skipped === 'number'
      ) {
        optCounts.tests_skipped = (r as { tests_skipped: number }).tests_skipped;
      }
      if (
        'tests_failed' in r &&
        typeof (r as { tests_failed?: unknown }).tests_failed === 'number'
      ) {
        optCounts.tests_failed = (r as { tests_failed: number }).tests_failed;
      }
      return buildVerifierReceiptV2({
        receipt_id: `gate-${i}`,
        verifier_id: cmd || `v-${i}`,
        argv: cmd.split(/\s+/).filter(Boolean),
        cwd: '.',
        env_profile_hash: 'gate',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        exit_code: exit,
        stdout: summary,
        stderr: '',
        workspace_revision: { compositeTreeHash: rev.compositeTreeHash ?? '' },
        scope,
        command: cmd,
        authoritative: isAuthoritativeReceipt(r as VerifierReceipt),
        freshness: stale ? 'stale' : 'fresh',
        ...optCounts,
      });
    });
    // Live workspace revision must come from the workspace, not the receipt self-hash.
    // If not provided, missing_revision will be enforced by the verifier kernel.
    const liveRevision = opts.currentWorkspaceRevisionHash ?? '';
    const adversarialReceipts = rawReceipts.map((r) => {
      const entry: {
        exit_code: number;
        summary: string;
        tests_skipped?: number;
        tests_total?: number;
        tests_failed?: number;
      } = {
        exit_code:
          'exitCode' in r
            ? Number((r as { exitCode?: number }).exitCode ?? 1)
            : 'exit_code' in r
              ? Number((r as { exit_code?: number }).exit_code ?? 1)
              : 1,
        summary: 'summary' in r ? String((r as { summary?: string }).summary ?? '') : '',
      };
      if (
        'tests_skipped' in r &&
        typeof (r as { tests_skipped?: unknown }).tests_skipped === 'number'
      ) {
        entry.tests_skipped = (r as { tests_skipped: number }).tests_skipped;
      }
      if ('tests_total' in r && typeof (r as { tests_total?: unknown }).tests_total === 'number') {
        entry.tests_total = (r as { tests_total: number }).tests_total;
      }
      if (
        'tests_failed' in r &&
        typeof (r as { tests_failed?: unknown }).tests_failed === 'number'
      ) {
        entry.tests_failed = (r as { tests_failed: number }).tests_failed;
      }
      return entry;
    });
    const adversarial = {
      ...deriveAdversarialSignals({
        toolCallLog: log,
        receipts: adversarialReceipts,
        hasWrite,
      }),
      ...(opts.adversarial ?? {}),
    };
    const promo = evaluateVerifierPromotion({
      mutating: true,
      task_class: opts.taskClass,
      required_verifier_commands: requiredVerifierCommands,
      receipts,
      current_revision_hash: liveRevision,
      adversarial,
    });
    if (!promo.authorize_verified_complete) return 'reject';
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
  requiredVerifierCommands?: readonly string[] | null;
  gateStrikes?: number;
  /** Canonical executed verifier ledger \u2014 when supplied, toolCallLog is not used for requirement satisfaction. */
  executedVerifierLedger?: readonly VerifierReceipt[] | readonly import('../executor/contracts.js').ExecutorVerifierReceipt[] | null;
  /** Adaptation errors from chat receipt \u2192 canonical receipt conversion. */
  verifierEvidenceErrors?: readonly string[] | null;
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
  const requiredVerifierCommands = resolveHonestyRequiredVerifiers({
    task: opts.task,
    ...(opts.projectTestCommands !== undefined
      ? { projectTestCommands: opts.projectTestCommands }
      : {}),
    ...(opts.requiredVerifierCommands !== undefined
      ? { requiredVerifierCommands: opts.requiredVerifierCommands }
      : {}),
  });
  const honesty = evaluateExecuteCompletionHonesty({
    hasWrite: true,
    policy,
    lastVerifierReceipt: opts.lastVerifierReceipt ?? null,
    toolCallLog: log,
    requiredVerifierCommands,
    executedVerifierLedger: opts.executedVerifierLedger ?? null,
    verifierEvidenceErrors: opts.verifierEvidenceErrors ?? null,
  });
  if (
    honesty.reason === 'verifier_missing' ||
    honesty.reason === 'verifier_red' ||
    honesty.reason === 'verifier_stale' ||
    honesty.reason === 'verifier_scope' ||
    honesty.reason === 'verifier_receipt_invalid'
  ) {
    return buildGreenVerifierRejectionMessage(
      honesty.reason,
      opts.lastVerifierReceipt,
      opts.projectTestCommands,
      opts.gateStrikes, // strikeCount
    );
  }
  return buildGateRejectionMessage(log);
}
