import path from 'node:path';
import { mandatoryVerifierProse } from '../config/verifierIntent.js';
/**
 * Completion honesty policy — when execute work is "done enough" to finish.
 * Pure helpers; no I/O.
 */

import { isConfirmedMutation, isDirectMutationTool, isVerifierAttemptTool, type MutationEffectStatus } from './mutationTools.js';
import { getChatTaskTune, isStrictVerification, type ChatTaskClass, type VerificationPolicy } from '../config/chatTaskClass.js';
import {
  buildGateRejectionMessage,
  hasAnyWrites as hasLoggedWrites,
  hasSubAgentWrites,
} from './chatEngineCriticBudget.js';
import { isVerifierAuthoritySource, type StructuredVerifierCommand, type VerifierAuthoritySource, type VerifierExecutionContext, type VerifierEventOrder, type VerifierEvidenceOwner, type RequiredVerifierRecord } from '../executor/contracts.js';
import { extractRequiredVerifierCommandsFromTask } from '../pipeline/planVerifierInjection.js';
import { extractVerifierCommand } from './chatEngineVerifierSession.js';
import { analyzeVerifierIdentity, satisfiesVerifierRequirement, verifierExecutionFingerprint } from '../services/verifierIdentity.js';
import {
  buildVerifierReceiptV2,
  evaluateVerifierPromotion,
  type VerifierScope,
} from './verifierKernel.js';
import { isCatOrTypeCommand } from './codingLoop/verificationStages.js';
import { parseCommandArgv } from '../utils/commandArgv.js';
import { isNodeTestCommand, isPythonTestCommand } from '../authority/commandDecoder.js';

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
  'npm run typecheck',
  'pnpm run typecheck',
  'yarn run typecheck',
  'npm run test',
  'npm test',
  'pnpm run test',
  'pnpm test',
  'yarn run test',
  'yarn test',
  'node --test',
  'npx jest',
  'npx vitest',
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

  const trimmed = command.trim();
  if (isNodeTestCommand(trimmed, trimmed)) return true;
  if (isPythonTestCommand(trimmed)) return true;

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
  let tokens: string[];
  try {
    tokens = parseCommandArgv(trimmed);
  } catch {
    return null;
  }
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

  // Help, version, list, collection, and dry-run exits are not executed proof.
  const identity = analyzeVerifierIdentity(trimmed);
  if (identity && identity.family !== 'unknown' && identity.scope === 'unknown') return false;

  // Deny-by-default: only allowlisted runners or session-bound commands
  return matchesAuthoritativeVerifierAllowlist(trimmed, boundCommands);
}

export type VerifierReceipt = {
  executionContext?: VerifierExecutionContext;
  order?: VerifierEventOrder;
  working_directory?: string;
  environment_policy?: string;
  target?: string;
  scope?: VerifierScope;
  tests_failed?: number;
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
  tests_total?: number;
  tests_skipped?: number;
};

export type GateToolLogEntry = {
  preDispatchNoEffect?: true;
  verifierExecuted?: boolean;
  tool: string;
  target: string;
  detail?: string;
  error?: string;
  exit_code?: number;
  mutation_paths?: string[];
  effect_status?: MutationEffectStatus;
  effect_scope?: import('./mutationTools.js').MutationEffectScope;
};

/** Recorded inspection can support a no-change conclusion, never patch certification. */
export function hasInspectedNoChangeEvidence(log: GateToolLogEntry[]): boolean {
  const unresolvedMutation = log.filter(entry => entry.preDispatchNoEffect !== true).some(entry => entry.effect_status === 'indeterminate'
    // Process success describes its exit, not its filesystem effects. In
    // particular, background starts and awaits cannot prove an unchanged tree.
    || ((isVerifierAttemptTool(entry.tool) || entry.tool === 'await_command')
      && entry.effect_status !== 'confirmed_no_change')
    || (isDirectMutationTool(entry.tool)
      && (Boolean(entry.error) || entry.effect_status !== 'confirmed_no_change'))
    || (entry.tool === 'sub_agent' && Boolean(entry.error)
      && entry.effect_status !== 'confirmed_no_change'));
  return !hasLoggedWrites(log) && !unresolvedMutation && log.some(entry =>
    ['read_file', 'read_range', 'grep', 'glob', 'list_dir', 'search', 'semantic_search', 'git_context', 'lsp'].includes(entry.tool)
    && !entry.error && (entry.exit_code === undefined || entry.exit_code === 0)
    && Boolean(entry.detail?.trim()));
}

/**
 * Task text explicitly asks to run tests / verify before complete.
 */
export function taskAsksForVerifier(task: string): boolean {
  task = mandatoryVerifierProse(task);
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

/** Single effective verification view for gate, recovery, kernel, and terminal metadata. */
export interface CompletionVerificationContext {
  requiredVerifiers: readonly RequiredVerifierRecord[];
  verifierOwner?: VerifierEvidenceOwner;
  tunePolicy: VerificationPolicy;
  resolvedPolicy: VerificationPolicy;
  requiredVerifierCommands: string[];
  honestyPolicy: VerificationPolicy;
  mandatoryVerifierContract: boolean;
  effectiveGatePolicy: VerificationPolicy;
}

export function resolveCompletionVerificationContext(opts: {
  taskClass: ChatTaskClass;
  task: string;
  projectTestCommands?: readonly string[] | null;
  requiredVerifierCommands?: readonly string[] | null;
  requiredVerifiers?: readonly RequiredVerifierRecord[];
  verifierOwner?: VerifierEvidenceOwner;
  toolCallLog?: GateToolLogEntry[];
}): CompletionVerificationContext {
  const tune = getChatTaskTune(opts.taskClass);
  const tunePolicy = tune.verificationPolicy;
  const resolvedPolicy = resolveVerificationPolicy({
    policy: tunePolicy,
    task: opts.task,
  });
  // Explicit user/host commands stay stronger than discovery. A supplied
  // host-bound record list also wins over heuristic project-wide defaults.
  const explicitCommands = resolveHonestyRequiredVerifiers({
    task: opts.task,
    ...(opts.requiredVerifierCommands !== undefined ? { requiredVerifierCommands: opts.requiredVerifierCommands } : {}),
  });
  const requiredVerifierCommands = explicitCommands.length > 0 ? explicitCommands
    : opts.requiredVerifiers !== undefined ? opts.requiredVerifiers.map(requirement => requirement.command)
      : resolveHonestyRequiredVerifiers({ task: opts.task,
        ...(opts.projectTestCommands !== undefined ? { projectTestCommands: opts.projectTestCommands } : {}),
      });
  const noChange =
    opts.toolCallLog !== undefined && hasInspectedNoChangeEvidence(opts.toolCallLog);
  const noChangeNeedsVerification =
    requiredVerifierCommands.length > 0 ||
    taskAsksForVerifier(opts.task) ||
    resolvedPolicy === 'strict';
  const honestyPolicy =
    noChange && !noChangeNeedsVerification
      ? 'none'
      : noChangeNeedsVerification && resolvedPolicy === 'none'
        ? 'required'
        : resolvedPolicy;
  const mandatoryVerifierContract = requiredVerifierCommands.length > 0;
  return {
    requiredVerifiers: opts.requiredVerifiers ?? [],
    ...(opts.verifierOwner ? { verifierOwner: opts.verifierOwner } : {}),
    tunePolicy,
    resolvedPolicy,
    requiredVerifierCommands,
    honestyPolicy,
    mandatoryVerifierContract,
    effectiveGatePolicy: honestyPolicy,
  };
}

/** Engine completion-gate path: effective policy from class, task, and live tool log. */
export function resolveEffectiveGatePolicyForEngineGate(opts: {
  taskClass: ChatTaskClass;
  task: string;
  projectTestCommands: readonly string[];
  requiredVerifierCommands?: readonly string[] | null;
  requiredVerifiers?: readonly RequiredVerifierRecord[];
  verifierOwner?: VerifierEvidenceOwner;
  toolCallLog: GateToolLogEntry[];
}): VerificationPolicy {
  return resolveCompletionVerificationContext({
    taskClass: opts.taskClass,
    task: opts.task,
    projectTestCommands: opts.projectTestCommands,
    ...(opts.requiredVerifierCommands !== undefined
      ? { requiredVerifierCommands: opts.requiredVerifierCommands }
      : {}),
    ...(opts.requiredVerifiers !== undefined ? { requiredVerifiers: opts.requiredVerifiers } : {}),
    ...(opts.verifierOwner ? { verifierOwner: opts.verifierOwner } : {}),
    toolCallLog: opts.toolCallLog,
  }).effectiveGatePolicy;
}

export function syncEffectiveGatePolicyAtCompletion(opts: {
  taskClass: ChatTaskClass;
  task: string;
  /** Host-resolved verifier list (includes discovered project tests when applicable). */
  requiredVerifierCommands: readonly string[];
  toolCallLog: GateToolLogEntry[];
}): VerificationPolicy {
  return resolveEffectiveGatePolicyForEngineGate({
    taskClass: opts.taskClass,
    task: opts.task,
    projectTestCommands: [],
    requiredVerifierCommands: opts.requiredVerifierCommands,
    toolCallLog: opts.toolCallLog,
  });
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
  /** Only non-certified no-change completion may use successful inspection instead of a mutation. */
  allowInspectedNoChange?: boolean;
  policy: VerificationPolicy;
  lastVerifierReceipt?: VerifierReceipt | import('../executor/contracts.js').ExecutorVerifierReceipt | null;
  toolCallLog: GateToolLogEntry[];
  /** Required full/targeted commands for structural scope (optional). */
  requiredVerifierCommands?: readonly string[] | null;
  requiredVerifiers?: readonly RequiredVerifierRecord[];
  verifierOwner?: VerifierEvidenceOwner;
  /** Ledger of executed verifier receipts (optional). */
  executedVerifierLedger?: readonly VerifierReceipt[] | readonly import('../executor/contracts.js').ExecutorVerifierReceipt[] | null;
  /** Errors produced during evidence adaptation (optional). */
  verifierEvidenceErrors?: readonly string[] | null;
  currentWorkspaceRevisionHash?: string | null;
  /** Independently host-rechecked currency for each receipt's bound scope. */
  currentReceiptRevisionHashes?: Readonly<Record<string, string>>;
  /** Host dispatch environment for truthful unplanned-attempt delivery only. */
  unplannedAttemptEnvironmentFingerprint?: string;
  proofSelection?: CompletionProofSelection;
}): { allow: boolean; reason: CompletionGateRejectReason } {
  // Precedence 1: Receipt adaptation failures deterministically reject completion.
  if (opts.verifierEvidenceErrors && opts.verifierEvidenceErrors.length > 0) {
    return { allow: false, reason: 'verifier_receipt_invalid' };
  }

  if (!opts.hasWrite && !(opts.allowInspectedNoChange && hasInspectedNoChangeEvidence(opts.toolCallLog))) {
    return { allow: false, reason: 'no_writes' };
  }
  if (opts.policy === 'none') {
    return { allow: true, reason: null };
  }

  const required = opts.requiredVerifierCommands ?? [];
  const unplannedDelivery=opts.policy === 'required' && required.length === 0 && (opts.requiredVerifiers?.length ?? 0) === 0 && !!opts.unplannedAttemptEnvironmentFingerprint;
  if (opts.requiredVerifiers !== undefined || opts.verifierOwner !== undefined) {
    const selection = opts.proofSelection ?? selectCompletionProof({
      requiredVerifiers: opts.requiredVerifiers ?? [],
      ...(unplannedDelivery ? {unplannedAttemptEnvironmentFingerprint:opts.unplannedAttemptEnvironmentFingerprint!} : {}),
      ...(opts.verifierOwner ? { owner: opts.verifierOwner } : {}),
      currentRevisionHash: opts.currentWorkspaceRevisionHash ?? '',
      ...(opts.currentReceiptRevisionHashes !== undefined ? { currentReceiptRevisionHashes: opts.currentReceiptRevisionHashes } : {}),
      receipts: opts.executedVerifierLedger ?? (opts.lastVerifierReceipt ? [opts.lastVerifierReceipt] : []),
    });
    if (required.some(command => !(opts.requiredVerifiers ?? []).some(record =>
      satisfiesVerifierRequirement(command, record.command)))) return { allow: false, reason: 'verifier_scope' };
    if (selection.evidenceErrors.length || (opts.policy === 'strict' && selection.integrityFindings.length)) return { allow: false, reason: 'verifier_receipt_invalid' };
    if (unplannedDelivery) return {allow:selection.currentAttempts.length > 0,reason:selection.currentAttempts.length ? null : 'verifier_missing'};
    if (selection.unresolvedRelevantFailures.length && opts.policy === 'strict') return { allow: false, reason: 'verifier_red' };
    if (selection.missingRequirements.length) {
      // Red evidence supports truthful partial delivery under required policy,
      // while promotion to VERIFIED_COMPLETE always requires green proof.
      const attemptedAll = selection.missingRequirements.every(requirement =>
        selection.currentAttempts.some(receipt => receiptCoversRequirement(requirement, receipt)));
      if (opts.policy === 'required' && attemptedAll) return { allow: true, reason: null };
      return { allow: false, reason: 'verifier_missing' };
    }
    return { allow: true, reason: null };
  }
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
    if (
      opts.policy === 'strict' &&
      !activeAttempts.some((entry) => verifierExitCode(entry) === 0 && receiptProvesExecutedTests(entry))
    ) {
      return { allow: false, reason: 'verifier_missing' };
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
    if (opts.policy === 'strict' && verifierExitCode(latest) === 0 && !receiptProvesExecutedTests(latest)) {
      hasMissingRequirement = true;
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

/** One proof selection shared by honesty, promotion and executor completion. */
export interface CompletionProofSelection {
  selectedCoveringReceipts: VerifierEvidence[];
  unresolvedRelevantFailures: VerifierEvidence[];
  missingRequirements: RequiredVerifierRecord[];
  evidenceErrors: string[];
  /** Valid current attempts, including red attempts for truthful partial delivery. */
  currentAttempts: VerifierEvidence[];
  integrityFindings: string[];
}

function sameOwner(context: VerifierExecutionContext, owner: VerifierEvidenceOwner): boolean {
  return context.workspaceRoot === owner.workspaceRoot && context.taskId === owner.taskId
    && context.contractHash === owner.contractHash;
}

function validExecutionContext(context: VerifierExecutionContext | undefined): context is VerifierExecutionContext {
  return context !== undefined && context !== null && typeof context === 'object' && ['workspaceRoot', 'taskId', 'contractHash', 'workingDirectory', 'environmentFingerprint']
    .every(key => typeof context[key as keyof VerifierExecutionContext] === 'string'
      && (context[key as keyof VerifierExecutionContext] as string).trim().length > 0)
    && Array.isArray(context.targetSelectors) && context.targetSelectors.every(selector => typeof selector === 'string')
    && (context.resolvedExecutable === undefined || (typeof context.resolvedExecutable === 'string' && context.resolvedExecutable.length > 0));
}

function sameExecutionContext(expected: VerifierExecutionContext, actual: VerifierExecutionContext): boolean {
  return expected.workspaceRoot === actual.workspaceRoot && expected.taskId === actual.taskId
    && expected.contractHash === actual.contractHash && expected.workingDirectory === actual.workingDirectory
    && expected.environmentFingerprint === actual.environmentFingerprint
    && (expected.resolvedExecutable === undefined || expected.resolvedExecutable === actual.resolvedExecutable);
}

function receiptCoversRequirement(requirement: RequiredVerifierRecord, receipt: VerifierEvidence): boolean {
  return receipt.executionContext !== undefined
    && sameExecutionContext(requirement.executionContext, receipt.executionContext)
    && (requirement.requiredScope !== 'full_suite' || receiptScopeFromLedgerEntry(receipt) === 'full_suite')
    && satisfiesVerifierRequirement(requirement.command, receipt.command);
}

export function greenProof(receipt: VerifierEvidence): boolean {
  return verifierExitCode(receipt) === 0 && (receipt.tests_failed ?? 0) === 0 && receiptProvesExecutedTests(receipt);
}

/**
 * Select covering proof from exact host attempts. No timestamps, ledger positions,
 * receipt-derived cwd defaults or guessed owner values establish provenance.
 * Historical receipts remain in the ledger but never veto a current covering proof.
 */
export function selectCompletionProof(input: {
  requiredVerifiers: readonly RequiredVerifierRecord[];
  owner?: VerifierEvidenceOwner;
  currentRevisionHash: string;
  currentReceiptRevisionHashes?: Readonly<Record<string, string>>;
  /** Host dispatch environment for truthful unplanned-attempt delivery only. */
  unplannedAttemptEnvironmentFingerprint?: string;
  receipts: readonly VerifierEvidence[];
}): CompletionProofSelection {
  const result: CompletionProofSelection = {
    selectedCoveringReceipts: [], unresolvedRelevantFailures: [], missingRequirements: [], evidenceErrors: [], currentAttempts: [], integrityFindings: [],
  };
  const independentSignals = deriveAdversarialSignals({
    hasWrite: false, toolCallLog: [], receipts: input.receipts.map(receipt => ({
      exit_code: verifierExitCode(receipt),
      ...('summary' in receipt && receipt.summary !== undefined ? { summary: receipt.summary } : {}),
      ...(receipt.tests_total !== undefined ? { tests_total: receipt.tests_total } : {}),
      ...(receipt.tests_skipped !== undefined ? { tests_skipped: receipt.tests_skipped } : {}),
      ...(receipt.tests_failed !== undefined ? { tests_failed: receipt.tests_failed } : {}),
    })),
  });
  result.integrityFindings = Object.entries(independentSignals).filter(([, found]) => found).map(([finding]) => finding);
  const owner = input.owner;
  if (!owner || ![owner.workspaceRoot, owner.taskId, owner.contractHash, owner.sessionId]
    .every(value => typeof value === 'string' && value.trim().length > 0)) {
    result.evidenceErrors.push('Missing current host verifier owner; rerun with host-bound evidence');
  }
  if (!input.currentRevisionHash) result.evidenceErrors.push('Missing live workspace revision currency');
  const unplanned = input.requiredVerifiers.length === 0 && !!input.unplannedAttemptEnvironmentFingerprint;
  if (!input.requiredVerifiers.length && !unplanned) result.evidenceErrors.push('Missing host-bound required verifiers');
  for (const requirement of input.requiredVerifiers) {
    const identity = analyzeVerifierIdentity(requirement.command);
    if (!validExecutionContext(requirement.executionContext) || !owner || !sameOwner(requirement.executionContext, owner)
      || (requirement.requiredScope !== 'full_suite' && requirement.requiredScope !== 'targeted')
      || typeof requirement.greenRequired !== 'boolean'
      || !identity || identity.scope === 'unknown'
      || JSON.stringify(requirement.executionContext.targetSelectors) !== JSON.stringify(identity.targetSelectors)) {
      result.evidenceErrors.push('Required verifier context does not belong to the current host owner');
    }
  }
  if (result.evidenceErrors.length || !owner) {
    result.missingRequirements = [...input.requiredVerifiers];
    return result;
  }
  const relevant = (receipt: VerifierEvidence): boolean => unplanned || input.requiredVerifiers.some(requirement =>
    satisfiesVerifierRequirement(requirement.command, receipt.command)
    || satisfiesVerifierRequirement(receipt.command, requirement.command));
  const seenOrders = new Map<number, VerifierEvidence>();
  for (const receipt of input.receipts) {
    const context = receipt.executionContext;
    const order = receipt.order;
    if (!isAuthoritativeReceipt(receipt) || !isVerifierAuthoritySource(receipt.authoritySource ?? ('authority_source' in receipt ? receipt.authority_source : undefined))) continue;
    const liveHash = input.currentReceiptRevisionHashes !== undefined
      ? input.currentReceiptRevisionHashes[receipt.receiptId ?? ''] : input.currentRevisionHash;
    if (receipt.stale !== true && !liveHash && relevant(receipt) &&
        (!validExecutionContext(context) || sameOwner(context, owner))) {
      result.evidenceErrors.push('Verifier scope currency is unavailable; rerun or reconcile required');
    }
    if (receipt.stale === true || !liveHash || (receipt.boundRevision?.compositeTreeHash
      && receipt.boundRevision.compositeTreeHash !== liveHash)) continue;
    // Known other owners/contexts are history. Unknown current evidence in a
    // relevant family cannot silently disappear, especially an unordered red.
    if (validExecutionContext(context) && !sameOwner(context, owner)) continue;
    if (!validExecutionContext(context)) {
      if (relevant(receipt)) result.evidenceErrors.push('Verifier execution context is unknown; rerun required');
      continue;
    }
    if (unplanned) {
      const within=path.relative(owner.workspaceRoot,context.workingDirectory);
      if (context.environmentFingerprint !== input.unplannedAttemptEnvironmentFingerprint || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
        result.evidenceErrors.push('Unplanned verifier context differs from the governed host context');
        continue;
      }
    } else if (!input.requiredVerifiers.some(requirement => sameExecutionContext(requirement.executionContext, context))) continue;
    const knownSession = order && typeof order.sessionId === 'string' && order.sessionId.trim().length > 0;
    if (knownSession && order.sessionId !== owner.sessionId) continue;
    if (!order || !knownSession || !Number.isSafeInteger(order.seq) || order.seq < 0
      || receipt.stale !== false || !receipt.boundRevision?.compositeTreeHash) {
      if (relevant(receipt)) result.evidenceErrors.push('Verifier durable order or live currency is unknown; rerun required');
      continue;
    }
    const identity = analyzeVerifierIdentity(receipt.command);
    const parsed = parseStructuredVerifierCommand(receipt.command);
    if (!identity || identity.scope === 'unknown' || JSON.stringify(context.targetSelectors) !== JSON.stringify(identity.targetSelectors)
      || receiptScopeFromLedgerEntry(receipt) !== (identity.scope === 'full' ? 'full_suite' : 'targeted')
      || !parsed || !receipt.argv || JSON.stringify(receipt.argv) !== JSON.stringify([parsed.executable, ...parsed.args])) {
      if (relevant(receipt)) result.evidenceErrors.push('Verifier command, argv or target projection disagrees');
      continue;
    }
    const previous = seenOrders.get(order.seq);
    if (previous) {
      // Repeated projections of one event are harmless. Conflicting claims to
      // the same durable host sequence cannot establish an execution order.
      if (JSON.stringify(previous) !== JSON.stringify(receipt)) result.evidenceErrors.push(`Conflicting verifier event sequence ${order.seq}`);
      continue;
    }
    seenOrders.set(order.seq, receipt);
    result.currentAttempts.push(receipt);
  }
  result.currentAttempts.sort((a, b) => a.order!.seq - b.order!.seq);
  const greens = result.currentAttempts.filter(greenProof);
  for (const failed of result.currentAttempts.filter(receipt => !greenProof(receipt) && relevant(receipt))) {
    if (!greens.some(green => green.order!.seq > failed.order!.seq
      && sameExecutionContext(failed.executionContext!, green.executionContext!)
      && satisfiesVerifierRequirement(failed.command, green.command))) result.unresolvedRelevantFailures.push(failed);
  }
  for (const requirement of input.requiredVerifiers) {
    const covering = greens.filter(receipt => receiptCoversRequirement(requirement, receipt)).at(-1);
    if (!covering) result.missingRequirements.push(requirement);
    else if (!result.selectedCoveringReceipts.includes(covering)) result.selectedCoveringReceipts.push(covering);
  }
  return result;
}

function deduplicateVerifierReceipts(
  receipts: readonly VerifierEvidence[],
): VerifierEvidence[] {
  const byIdentity = new Map<string, VerifierEvidence>();
  for (const receipt of receipts) {
    const key = JSON.stringify([verifierExecutionFingerprint(receipt.command), receipt.executionContext ?? null,
      receipt.working_directory ?? null, receipt.environment_policy ?? null, receipt.target ?? null]);
    // Map insertion order is retained while assignment makes the latest
    // attempt authoritative for a structural identity.
    byIdentity.set(key, receipt);
  }
  return [...byIdentity.values()];
}

function isAuthoritativeReceipt(entry: VerifierEvidence): boolean {
  return entry.authority === true && typeof entry.command === 'string' && isAuthoritativeVerifierCommand(entry.command);
}

/**
 * Count-free proof is an explicit list of non-test checks. Every other
 * command, including `npm run test:unit` and the pnpm/yarn equivalents,
 * requires a parsed executed-test count. Family keys stay unchanged:
 * `test:unit` is not collapsed into `npm-test`.
 */
export function strictCountPolicy(command: string): 'count_free' | 'requires_executed_count' {
  const identity = analyzeVerifierIdentity(command);
  if (!identity || identity.scope === 'unknown') return 'requires_executed_count';
  if (identity.family === 'tsc' || identity.family === 'tsc-b') return 'count_free';
  let argv: string[];
  try {
    argv = parseCommandArgv(identity.displayCommand);
  } catch {
    return 'requires_executed_count';
  }
  const executable = argv[0]
    ?.replace(/^['"]|['"]$/g, '')
    .split(/[\\/]/)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.(cmd|bat|exe)$/i, '');
  const script = argv[2]?.replace(/^['"]|['"]$/g, '').toLowerCase();
  if (
    (executable === 'npm' || executable === 'pnpm' || executable === 'yarn')
    && argv[1]?.toLowerCase() === 'run'
    && script === 'typecheck'
  ) {
    return 'count_free';
  }
  return 'requires_executed_count';
}

function evidenceCommand(entry: VerifierEvidence | GateToolLogEntry): string | undefined {
  if ('command' in entry && typeof entry.command === 'string') return entry.command;
  if ('target' in entry && typeof entry.target === 'string') return entry.target;
  return undefined;
}

function evidenceOutput(entry: VerifierEvidence | GateToolLogEntry): string {
  const parts: string[] = [];
  if ('summary' in entry && typeof entry.summary === 'string') parts.push(entry.summary);
  if ('detail' in entry && typeof entry.detail === 'string') parts.push(entry.detail);
  const raw = entry as { stdout?: unknown; stderr?: unknown };
  if (typeof raw.stdout === 'string') parts.push(raw.stdout);
  if (typeof raw.stderr === 'string') parts.push(raw.stderr);
  return parts.join('\n');
}

function explicitExecutedTestCounts(
  entry: VerifierEvidence | GateToolLogEntry,
): { tests_total: number; tests_skipped: number } | null {
  const counted = entry as { tests_total?: unknown; tests_skipped?: unknown };
  if (typeof counted.tests_total !== 'number' || !Number.isFinite(counted.tests_total)) return null;
  const testsSkipped = typeof counted.tests_skipped === 'number' && Number.isFinite(counted.tests_skipped)
    ? counted.tests_skipped
    : 0;
  return { tests_total: counted.tests_total, tests_skipped: testsSkipped };
}

/**
 * A green test command is proof only when captured or runner-reported counts
 * show that a test actually ran. A non-test check such as `npm run typecheck`
 * has no count and is proved by its own green exit.
 */
function receiptProvesExecutedTests(entry: VerifierEvidence | GateToolLogEntry): boolean {
  const command = evidenceCommand(entry);
  if (command && strictCountPolicy(command) === 'count_free') {
    return verifierExitCode(entry) === 0;
  }
  const counts = explicitExecutedTestCounts(entry)
    ?? parseExecutedTestCounts(evidenceOutput(entry), command);
  if (!counts || !Number.isFinite(counts.tests_total) || counts.tests_total <= 0) return false;
  if (counts.tests_skipped >= counts.tests_total) return false;
  return true;
}

function integerCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function collectCountWords(phrase: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const match of phrase.matchAll(/(\d+)\s+([A-Za-z]+)/g)) {
    const word = match[2];
    if (!word) continue;
    found[word.toLowerCase()] = Number(match[1]);
  }
  return found;
}

function parseNodeTestCounts(text: string): { tests_total: number; tests_skipped: number } | null {
  const totals = [...text.matchAll(/^(?:ℹ|#)\s+tests\s+(\d+)\s*$/gm)];
  const lastTotal = totals.at(-1)?.[1];
  if (lastTotal === undefined) return null;
  const testsTotal = Number(lastTotal);
  const skipped = [...text.matchAll(/^(?:ℹ|#)\s+skipped\s+(\d+)\s*$/gm)].at(-1)?.[1];
  const testsSkipped = skipped === undefined ? 0 : Number(skipped);
  if (!integerCount(testsTotal) || !integerCount(testsSkipped)) return null;
  return { tests_total: testsTotal, tests_skipped: testsSkipped };
}

function parsePytestCounts(text: string): { tests_total: number; tests_skipped: number } | null {
  const token = String.raw`\d+\s+(?:failed|passed|skipped|errors?|xfailed|xpassed|warnings?|deselected|reruns?)`;
  const line = new RegExp(
    `^(?:=+\\s*)?((?:${token}(?:,\\s*)?)+)(?:\\s+in\\s+[\\d.]+s)?\\s*(?:=+)?\\s*$`,
    'gim',
  );
  const phrase = [...text.matchAll(line)].at(-1)?.[1];
  if (!phrase) return null;
  const words = collectCountWords(phrase);
  const testsSkipped = words.skipped ?? 0;
  const testsTotal = (words.passed ?? 0)
    + (words.failed ?? 0)
    + (words.error ?? 0)
    + (words.errors ?? 0)
    + (words.xfailed ?? 0)
    + (words.xpassed ?? 0)
    + testsSkipped;
  if (!integerCount(testsTotal) || !integerCount(testsSkipped)) return null;
  if (
    testsTotal === 0
    && words.passed === undefined
    && words.failed === undefined
    && words.skipped === undefined
    && words.error === undefined
    && words.errors === undefined
  ) {
    return null;
  }
  return { tests_total: testsTotal, tests_skipped: testsSkipped };
}

function parseJestCounts(text: string): { tests_total: number; tests_skipped: number } | null {
  const phrase = [...text.matchAll(/^Tests:\s+(.+)$/gim)].at(-1)?.[1];
  if (!phrase) return null;
  const words = collectCountWords(phrase);
  const testsSkipped = (words.skipped ?? 0) + (words.todo ?? 0) + (words.pending ?? 0);
  const testsTotal = words.total
    ?? ((words.passed ?? 0) + (words.failed ?? 0) + testsSkipped);
  if (!integerCount(testsTotal) || !integerCount(testsSkipped)) return null;
  if (words.total === undefined && testsTotal === 0) return null;
  return { tests_total: testsTotal, tests_skipped: testsSkipped };
}

function parseVitestCounts(text: string): { tests_total: number; tests_skipped: number } | null {
  const phrase = [...text.matchAll(/^[ \t]*Tests[ \t]+([^:\n].*)$/gim)].at(-1)?.[1];
  if (!phrase) return null;
  const words = collectCountWords(phrase);
  const testsSkipped = (words.skipped ?? 0) + (words.todo ?? 0);
  const paren = phrase.match(/\((\d+)\)\s*$/);
  const testsTotal = paren
    ? Number(paren[1])
    : (words.passed ?? 0) + (words.failed ?? 0) + testsSkipped;
  if (!integerCount(testsTotal) || !integerCount(testsSkipped)) return null;
  if (!paren && testsTotal === 0) return null;
  return { tests_total: testsTotal, tests_skipped: testsSkipped };
}

function parseUnittestCounts(text: string): { tests_total: number; tests_skipped: number } | null {
  const ran = [...text.matchAll(/^Ran (\d+) tests?\b/gim)].at(-1)?.[1];
  if (ran === undefined) return null;
  const skipped = [...text.matchAll(/\bskipped=(\d+)/gi)].at(-1)?.[1];
  const testsTotal = Number(ran);
  const testsSkipped = skipped === undefined ? 0 : Number(skipped);
  if (!integerCount(testsTotal) || !integerCount(testsSkipped)) return null;
  return { tests_total: testsTotal, tests_skipped: testsSkipped };
}

function parseMochaCounts(text: string): { tests_total: number; tests_skipped: number } | null {
  const passing = [...text.matchAll(/^[ \t]*(\d+)\s+passing(?:\s+\([^)\n]*\))?\s*$/gim)].at(-1)?.[1];
  if (passing === undefined) return null;
  const pending = [...text.matchAll(/^[ \t]*(\d+)\s+pending\s*$/gim)].at(-1)?.[1];
  const failing = [...text.matchAll(/^[ \t]*(\d+)\s+failing\s*$/gim)].at(-1)?.[1];
  const passed = Number(passing);
  const testsSkipped = pending === undefined ? 0 : Number(pending);
  const failed = failing === undefined ? 0 : Number(failing);
  if (!integerCount(passed) || !integerCount(testsSkipped) || !integerCount(failed)) return null;
  return { tests_total: passed + testsSkipped + failed, tests_skipped: testsSkipped };
}

/**
 * Counts from a runner's own report. Node's machine lines, pytest's summary,
 * Jest's `Tests:` line, and Vitest's `Tests` line are accepted. A hand-written
 * "ok" or "all pass" does not mint a count.
 */
export function parseExecutedTestCounts(
  output: string,
  command?: string,
): { tests_total: number; tests_skipped: number } | null {
  const text = output.replace(/\r/g, '').replace(/\u001b\[[0-9;]*m/g, '');
  const family = command ? analyzeVerifierIdentity(command)?.family : undefined;
  if (family === 'node-test') return parseNodeTestCounts(text);
  if (family === 'pytest') return parsePytestCounts(text);
  if (family === 'unittest') return parseUnittestCounts(text);
  if (family === 'jest') return parseJestCounts(text);
  if (family === 'vitest') return parseVitestCounts(text);
  if (family === 'mocha') return parseMochaCounts(text);
  return parseNodeTestCounts(text)
    ?? parseJestCounts(text)
    ?? parseVitestCounts(text)
    ?? parsePytestCounts(text)
    ?? parseUnittestCounts(text)
    ?? parseMochaCounts(text);
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
  requiredVerifierCommands?: readonly string[] | null,
): string {
  const hasProjectTestCommands = Boolean(projectTestCommands?.length)
  const requiredCommands = requiredVerifierCommands?.filter(Boolean) ?? []
  const hasRequiredVerifierCommands = requiredCommands.length > 0
  const hasAvailableVerifierCommands = hasProjectTestCommands || hasRequiredVerifierCommands
  const cmdHint = hasProjectTestCommands
    ? `\nProject test commands: ${projectTestCommands!.join(', ')}.`
    : hasRequiredVerifierCommands
      ? `\nRequired verifier commands: ${requiredCommands.join(', ')}.`
      : ''

  const isStrike = strikeCount != null && strikeCount >= 2;
  const preamble = isStrike
    ? `This is rejection #${strikeCount}. ${hasAvailableVerifierCommands
      ? 'Your previous verification attempts were not valid test runs.'
      : 'No accepted verifier evidence is available.'}${
        strikeCount >= 3 ? ' FINAL ATTEMPT before the task is blocked.' : ''
      } `
    : '';

  const strikeEscalation = isStrike
    ? hasProjectTestCommands
      ? `After ${strikeCount} gate rejections, your next completion attempt will be auto-blocked. You MUST run and pass one of the listed project verifiers before completing.`
      : hasRequiredVerifierCommands
        ? `After ${strikeCount} gate rejections, your next completion attempt will be auto-blocked. Run the configured required verifier command(s) in the authorized execution environment; a command denied before dispatch remains not run.`
      : `After ${strikeCount} gate rejections, your next completion attempt will be auto-blocked. Do not repeat denied probes or invent tests; state the deliverable and verification limitation honestly.`
    : '';

  if (reason === 'verifier_receipt_invalid') {
    return [
      preamble,
      `COMPLETION_GATE_REJECTED: verifier_receipt_invalid`,
      `Verifier receipt evidence is missing required bound revision or authority metadata.`,
      hasProjectTestCommands
        ? `Re-run a listed authoritative project test command and complete only with a current accepted receipt.${cmdHint}`
        : hasRequiredVerifierCommands
          ? `No project test command was discovered, but required verifier command(s) are configured: ${requiredCommands.join(', ')}. Run each required command in the authorized execution environment and complete only with current accepted receipt evidence. A command denied before dispatch did not run; report if the required verifier is unavailable.${cmdHint}`
          : `No project test command was identified. A command denied before dispatch did not run and is not test evidence. Do not repeat denied probes or invent a version probe or one-off script. State the artifact and observed result accurately, and say when authoritative testing was unavailable; this does not certify completion.`,
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
    toolCallLog.some((e) => isConfirmedMutation({
      tool: e.tool,
      error: e.error,
      effectStatus: e.effect_status,
      effectScope: e.effect_scope,
      mutationPaths: e.mutation_paths,
    })) ||
    hasSubAgentWrites(toolCallLog)
  );
}

/** One bounded recovery allowance for unsupported completion claims. */
export const MAX_COMPLETION_RECOVERY_RETRIES = 3;

export function buildCompletionEvidenceBlockedReport(reason: string): {
  schema_version: 1;
  status: 'BLOCKED';
  reason_code: 'recovery_exhausted';
  cause_class: 'harness';
  reason: string;
  missing: string;
  checked: Array<{ action: string; target: string; finding: string }>;
} {
  return {
    schema_version: 1,
    status: 'BLOCKED',
    reason_code: 'recovery_exhausted',
    cause_class: 'harness',
    reason,
    missing: 'Successful inspection supporting a no-change conclusion, or a completed change with required evidence',
    checked: [
      {
        action: 'completion_gate',
        target: 'current_task',
        finding: 'Repeated final answers did not satisfy the completion evidence contract',
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
  | { kind: 'reject_continue'; gateStrikesAfter: number; useGreenMessage: boolean }
  | { kind: 'blocked'; reason: string; missingInspection?: true }
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
  hasInspectedNoChange?: boolean;
  policy: VerificationPolicy;
  hardGate: boolean;
  hadToolCallsThisTurn: boolean;
  gateStrikes: number;
  maxGateStrikes: number;
  /** Host/frozen required verifier list — missing receipt must never soft-allow. */
  mandatoryVerifierContract?: boolean;
}): GateRejectPlan {
  let enforceHard = shouldHardBlockVerifierHonesty({
    policy: opts.policy,
    hardGate: opts.hardGate,
  });
  if (opts.mandatoryVerifierContract) {
    enforceHard = true;
  }

  if (!opts.hasWrites && !opts.hasInspectedNoChange) {
    const next = opts.gateStrikes + 1;
    if (next <= opts.maxGateStrikes) {
      return {
        kind: 'reject_continue',
        gateStrikesAfter: next,
        useGreenMessage: false,
      };
    }
    return {
      kind: 'blocked',
      missingInspection: true,
      reason: `Completion recovery exhausted after ${next} unsupported final answers. No successful inspection supports a no-change conclusion and no completed change is recorded.`,
    };
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
  requiredVerifiers?: readonly RequiredVerifierRecord[];
  verifierOwner?: VerifierEvidenceOwner;
  /** Canonical executed verifier ledger — when supplied, toolCallLog is not used for requirement satisfaction. */
  executedVerifierLedger?: readonly VerifierReceipt[] | readonly import('../executor/contracts.js').ExecutorVerifierReceipt[] | null;
  /** Adaptation errors from chat receipt → canonical receipt conversion. */
  verifierEvidenceErrors?: readonly string[] | null;
  /**
   * H5: live workspace revision hash at completion time.
   * Must NOT be taken from the receipt itself (that makes wrong_revision tautological).
   */
  currentWorkspaceRevisionHash?: string | null;
  /** Independently host-rechecked currency for each receipt's bound scope. */
  currentReceiptRevisionHashes?: Readonly<Record<string, string>>;
  /** Host dispatch environment for truthful unplanned-attempt delivery only. */
  unplannedAttemptEnvironmentFingerprint?: string;
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
  const verification = resolveCompletionVerificationContext({
    taskClass: opts.taskClass,
    task: opts.task,
    ...(opts.projectTestCommands !== undefined
      ? { projectTestCommands: opts.projectTestCommands }
      : {}),
    ...(opts.requiredVerifierCommands !== undefined
      ? { requiredVerifierCommands: opts.requiredVerifierCommands }
      : {}),
    ...(opts.requiredVerifiers !== undefined ? { requiredVerifiers: opts.requiredVerifiers } : {}),
    ...(opts.verifierOwner ? { verifierOwner: opts.verifierOwner } : {}),
    toolCallLog: log,
  });
  const policy = verification.resolvedPolicy;
  const requiredVerifierCommands = verification.requiredVerifierCommands;
  const noChange = hasInspectedNoChangeEvidence(log);
  const rawReceipts = opts.executedVerifierLedger ?? (opts.lastVerifierReceipt ? [opts.lastVerifierReceipt] : []);
  const selection = selectCompletionProof({
    requiredVerifiers: verification.requiredVerifiers,
    ...(opts.verifierOwner ? { owner: opts.verifierOwner } : {}),
    currentRevisionHash: opts.currentWorkspaceRevisionHash ?? '', receipts: rawReceipts,
    ...(verification.honestyPolicy === 'required' && verification.requiredVerifiers.length === 0 && opts.unplannedAttemptEnvironmentFingerprint
      ? {unplannedAttemptEnvironmentFingerprint:opts.unplannedAttemptEnvironmentFingerprint} : {}),
    ...(opts.currentReceiptRevisionHashes !== undefined ? { currentReceiptRevisionHashes: opts.currentReceiptRevisionHashes } : {}),
  });
  const honesty = evaluateExecuteCompletionHonesty({
    hasWrite,
    allowInspectedNoChange: noChange,
    policy: verification.honestyPolicy,
    lastVerifierReceipt: opts.lastVerifierReceipt ?? null,
    toolCallLog: log,
    requiredVerifierCommands,
    ...(opts.requiredVerifiers !== undefined ? { requiredVerifiers: opts.requiredVerifiers } : {}),
    ...(opts.verifierOwner ? { verifierOwner: opts.verifierOwner } : {}),
    currentWorkspaceRevisionHash: opts.currentWorkspaceRevisionHash ?? null,
    ...(opts.unplannedAttemptEnvironmentFingerprint ? {unplannedAttemptEnvironmentFingerprint:opts.unplannedAttemptEnvironmentFingerprint} : {}),
    ...(opts.currentReceiptRevisionHashes !== undefined ? { currentReceiptRevisionHashes: opts.currentReceiptRevisionHashes } : {}),
    proofSelection: selection,
    executedVerifierLedger: opts.executedVerifierLedger ?? null,
    verifierEvidenceErrors: opts.verifierEvidenceErrors ?? null,
  });
  if (!honesty.allow) return 'reject';
  if (opts.executedVerifierLedger == null && opts.lastVerifierReceipt && isCatOrTypeCommand(opts.lastVerifierReceipt.command)) {
    return 'reject';
  }
  if (opts.executedVerifierLedger == null && opts.lastVerifierReceipt && opts.lastVerifierReceipt.stale === true) {
    return 'reject';
  }
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
  // Host-bound obligations require identical proof selection regardless of
  // natural-language phrasing or the task class's heuristic default policy.
  const needsPromotion = hasWrite && requiredVerifierCommands.length > 0
    && (policy === 'strict' || verification.requiredVerifiers.some(requirement => requirement.greenRequired));
  if (needsPromotion) {
    if (selection.evidenceErrors.length || selection.integrityFindings.length || selection.missingRequirements.length || selection.unresolvedRelevantFailures.length) return 'reject';
    const receipts = selection.selectedCoveringReceipts.map((r) => buildVerifierReceiptV2({
      receipt_id: r.receiptId ?? '', verifier_id: r.verifierId ?? ('verifier_id' in r ? r.verifier_id : undefined) ?? '',
      argv: r.argv ? [...r.argv] : [], cwd: r.executionContext!.workingDirectory,
      env_profile_hash: r.executionContext!.environmentFingerprint,
      // This is the captured event's wall time for display only. Ordering uses seq.
      started_at: r.capturedAt !== undefined ? new Date(r.capturedAt).toISOString() : '',
      ended_at: r.capturedAt !== undefined ? new Date(r.capturedAt).toISOString() : '',
      exit_code: verifierExitCode(r) ?? 1,
      stdout: 'summary' in r ? r.summary ?? '' : '', stderr: '',
      workspace_revision: { compositeTreeHash: r.boundRevision?.compositeTreeHash ?? '' },
      scope: receiptScopeFromLedgerEntry(r), command: r.command,
      authoritative: isAuthoritativeReceipt(r), freshness: r.stale === false ? 'fresh' : 'unknown',
      ...(r.tests_total !== undefined ? { tests_total: r.tests_total } : {}),
      ...(r.tests_skipped !== undefined ? { tests_skipped: r.tests_skipped } : {}),
      ...(r.tests_failed !== undefined ? { tests_failed: r.tests_failed } : {}),
    }));
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
    const derivedAdversarial = deriveAdversarialSignals({ toolCallLog: log, receipts: adversarialReceipts, hasWrite });
    const adversarial = { ...derivedAdversarial };
    for (const key of ['tests_deleted', 'shortcut_noop', 'hardcoded_fixture', 'flaky_green', 'baseline_failing', 'verifier_def_tampered'] as const) {
      if (opts.adversarial?.[key] === true) adversarial[key] = true;
    }
    const promo = evaluateVerifierPromotion({
      mutating: true,
      task_class: opts.taskClass,
      required_verifier_commands: requiredVerifierCommands,
      receipts,
      current_revision_hash: liveRevision,
      ...(opts.currentReceiptRevisionHashes !== undefined ? { current_revision_hashes: opts.currentReceiptRevisionHashes } : {}),
      required_verifiers: verification.requiredVerifiers,
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
  requiredVerifiers?: readonly RequiredVerifierRecord[];
  verifierOwner?: VerifierEvidenceOwner;
  currentWorkspaceRevisionHash?: string | null;
  /** Independently host-rechecked currency for each receipt's bound scope. */
  currentReceiptRevisionHashes?: Readonly<Record<string, string>>;
  /** Host dispatch environment for truthful unplanned-attempt delivery only. */
  unplannedAttemptEnvironmentFingerprint?: string;
  gateStrikes?: number;
  /** Canonical executed verifier ledger \u2014 when supplied, toolCallLog is not used for requirement satisfaction. */
  executedVerifierLedger?: readonly VerifierReceipt[] | readonly import('../executor/contracts.js').ExecutorVerifierReceipt[] | null;
  /** Adaptation errors from chat receipt \u2192 canonical receipt conversion. */
  verifierEvidenceErrors?: readonly string[] | null;
}): string {
  const log = opts.toolCallLog;
  if (!opts.hasAnyWrites && !hasInspectedNoChangeEvidence(log)) {
    return buildGateRejectionMessage(log);
  }
  const verification = resolveCompletionVerificationContext({
    taskClass: opts.taskClass,
    task: opts.task,
    ...(opts.projectTestCommands !== undefined
      ? { projectTestCommands: opts.projectTestCommands }
      : {}),
    ...(opts.requiredVerifierCommands !== undefined
      ? { requiredVerifierCommands: opts.requiredVerifierCommands }
      : {}),
    ...(opts.requiredVerifiers !== undefined ? { requiredVerifiers: opts.requiredVerifiers } : {}),
    ...(opts.verifierOwner ? { verifierOwner: opts.verifierOwner } : {}),
    toolCallLog: log,
  });
  const honesty = evaluateExecuteCompletionHonesty({
    hasWrite: opts.hasAnyWrites,
    allowInspectedNoChange: hasInspectedNoChangeEvidence(log),
    policy: verification.honestyPolicy,
    lastVerifierReceipt: opts.lastVerifierReceipt ?? null,
    toolCallLog: log,
    requiredVerifierCommands: verification.requiredVerifierCommands,
    ...(opts.requiredVerifiers !== undefined ? { requiredVerifiers: opts.requiredVerifiers } : {}),
    ...(opts.verifierOwner ? { verifierOwner: opts.verifierOwner } : {}),
    currentWorkspaceRevisionHash: opts.currentWorkspaceRevisionHash ?? null,
    ...(opts.unplannedAttemptEnvironmentFingerprint ? {unplannedAttemptEnvironmentFingerprint:opts.unplannedAttemptEnvironmentFingerprint} : {}),
    ...(opts.currentReceiptRevisionHashes !== undefined ? { currentReceiptRevisionHashes: opts.currentReceiptRevisionHashes } : {}),
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
      verification.requiredVerifierCommands,
    );
  }
  return buildGateRejectionMessage(log);
}
