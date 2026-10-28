/**
 * Verifier preparation and required-command resolution helper for ChatEngine.
 */
import { nativeNodeResultCounts } from './nativeTestResultCounts.js';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { isCredentialTargetPath } from './autonomyEnforcement.js';
import { requireProjectRoot, type ChatScopeInput } from './chatExecutionScope.js';

import {
  bindChatVerifierReceipt,
  evaluateChatVerifierReceiptCurrencySync,
  refreshChatVerifierReceiptStalenessSync,
  toExecutorVerifierReceipt,
  type BoundChatVerifierReceipt,
} from '../evidence/chatRevisionBinding.js';
import {
  isVerifierAuthoritySource,
  type ExecutorVerifierReceipt,
  type VerifierExecutionContext,
  type VerifierEvidenceOwner,
} from '../executor/contracts.js';
import {
  recordVerifierAttempt,
  type SessionEventLog,
} from './sessionEvents.js';
import { discoverVerifierInputClosure, RevisionManager } from '../evidence/revisionBoundReceipt.js';
import {
  analyzeVerifierIdentity,
  verifierExecutionFingerprint,
} from '../services/verifierIdentity.js';
import {
  isAuthoritativeVerifierCommand,
  parseExecutedTestCounts,
  parseStructuredVerifierCommand,
  resolveHonestyRequiredVerifiers,
} from './completionGatePolicy.js';

export { parseExecutedTestCounts };

/** Capture the live revision used by the streaming completion gate. */
export function captureCompletionWorkspaceRevisionHash(
  scope: ChatScopeInput,
  mutationPaths: string[],
  receipt: BoundChatVerifierReceipt | null,
): string | undefined {
  const root = requireProjectRoot(scope);
  const bound = receipt?.boundRevision;
  if (!bound?.scope || (bound.gitBinding !== 'required' && bound.gitBinding !== 'optional')) return undefined;
  const relativePaths = toRepositoryRelativePaths(root, mutationPaths);
  if (!relativePaths || (mutationPaths.length > 0 && !relativePaths.length)) return undefined;
  const verifierScope = bound.scope;
  const mutations = relativePaths.length ? RevisionManager.computeRevisionSync(root, relativePaths) : null;
  if (verifierScope.kind === 'files') {
    if (mutations && (mutations.scope?.kind !== 'files' ||
      mutations.scope.paths.some(file => !verifierScope.paths.includes(file)))) return undefined;
  } else if (verifierScope.kind !== 'repository' || bound.gitBinding !== 'required') return undefined;
  return RevisionManager.computeRevisionSync(root,
    verifierScope.kind === 'files' ? verifierScope.paths : [],
    { scope_kind: verifierScope.kind, git_binding: bound.gitBinding },
  ).compositeTreeHash;
}

/** Recheck current receipt inputs before completion, retaining project-scope denial. */
export function refreshChatCompletionVerifierCurrency(
  scope: ChatScopeInput,
  hasMutation: boolean,
  lastReceipt: BoundChatVerifierReceipt | null,
  ledger: readonly BoundChatVerifierReceipt[],
): void {
  if (scope.projectRoot) {
    const root = requireProjectRoot(scope);
    for (const receipt of new Set([lastReceipt, ...ledger])) {
      refreshChatVerifierReceiptStalenessSync(root, receipt);
    }
  } else if (hasMutation || lastReceipt || ledger.length) {
    throw new Error('PROJECT_REQUIRED: Conversation cannot certify project effects');
  }
}

export function resolveEngineRequiredVerifiers(input: {
  task: string;
  projectTestCommands?: readonly string[] | null;
  requiredVerifierCommands?: readonly string[] | null;
}): string[] {
  return resolveHonestyRequiredVerifiers(input);
}

/** Capture a structurally authoritative chat verifier receipt after execution. */
export async function captureChatVerifierReceipt(input: {
  projectRoot: string;
  command: string;
  exitCode: number;
  summary: string;
  stdout?: string;
  stderr?: string;
  mutationPaths: string[];
  /** Explicit red-only baseline route; cannot satisfy a green completion. */
  allowRepositoryScopeForRedRecovery?: boolean;
  /** Explicit no-patch route for a successful verifier after inspected no-change. */
  allowRepositoryScopeForGreenNoChange?: boolean;
  executionContext?: VerifierExecutionContext;
  execution?: {
    working_directory?: string;
    environment_policy?: string;
    target?: string;
  };
}): Promise<BoundChatVerifierReceipt | null> {
  if (!isAuthoritativeVerifierCommand(input.command)) return null;
  const parsed = parseStructuredVerifierCommand(input.command, {
    authoritySource: 'built_in_runner',
  });
  if (!parsed || !isVerifierAuthoritySource(parsed.authoritySource)) return null;
  // The revision binding requires repository-relative scope paths, but the
  // governed mutation path reports absolute paths. Canonicalize here so a
  // successful write + authoritative verifier can bind its revision instead
  // of throwing and corrupting the loop.
  const mutationPaths = toRepositoryRelativePaths(input.projectRoot, input.mutationPaths);
  if (mutationPaths === null) return null;
  // Admission must precede closure and revision content reads, including paths
  // the ordinary closure omits because they are credential-class inputs.
  for (const mutation of mutationPaths) {
    const absolute = path.resolve(input.projectRoot, mutation);
    if (isCredentialTargetPath(mutation) || isCredentialTargetPath(absolute)) return null;
    try {
      if (isCredentialTargetPath(realpathSync(absolute))) return null;
    } catch (error) {
      // Deleted ordinary inputs can still bind their missing-file state.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  let inputClosure = discoverVerifierInputClosure(input.projectRoot);
  let freshProof = false;
  if (inputClosure.mode === 'unsupported' && inputClosure.reason === 'Input closure exceeds the file cap') {
    inputClosure = discoverVerifierInputClosure(input.projectRoot, true);
    freshProof = inputClosure.mode === 'bound';
  }
  if (inputClosure.mode === 'unsupported') return null;
  const boundMutationPaths = inputClosure.mode === 'bound' && mutationPaths.length > 0
    ? [...new Set([...mutationPaths, ...inputClosure.paths])].sort()
    : mutationPaths;
  const repositoryScopedRed = input.allowRepositoryScopeForRedRecovery === true &&
    input.exitCode !== 0 && mutationPaths.length === 0;
  const repositoryScopedGreenNoChange = input.allowRepositoryScopeForGreenNoChange === true &&
    input.exitCode === 0 && mutationPaths.length === 0;
  if (freshProof && mutationPaths.length === 0 && !repositoryScopedRed && !repositoryScopedGreenNoChange) return null;
  const repositoryScoped = repositoryScopedRed || repositoryScopedGreenNoChange || freshProof;
  try {
    const receipt = await bindChatVerifierReceipt({
      projectRoot: input.projectRoot,
      command: input.command,
      exit_code: input.exitCode,
      summary: input.summary,
      mutationPaths: repositoryScoped ? [] : boundMutationPaths,
      ...(repositoryScoped ? {
        scopeKind: 'repository' as const,
        gitBinding: 'required' as const,
      } : {}),
      structured: {
        verifierId: parsed.verifierId,
        authoritySource: parsed.authoritySource,
        executable: parsed.executable,
        args: parsed.args,
      },
      ...(input.execution ? { execution: input.execution } : {}),
      ...(input.executionContext ? { executionContext: input.executionContext } : {}),
    });
    receipt.inputClosure = inputClosure;
    const counts = parseExecutedTestCounts(
      `${input.stdout ?? ''}\n${input.stderr ?? ''}`,
      input.command,
    );
    if (counts) {
      receipt.tests_total = counts.tests_total;
      receipt.tests_skipped = counts.tests_skipped;
      const native = nativeNodeResultCounts(input.command, `${input.stdout ?? ''}\n${input.stderr ?? ''}`);
      if (native && native.tests_total === counts.tests_total && native.tests_skipped === counts.tests_skipped) Object.assign(receipt, native);
    }
    return receipt;
  } catch (error) {
    if (repositoryScoped) return null;
    throw error;
  }
}

/**
 * Normalize scope paths to a POSIX repository-relative form. Already-relative
 * paths pass through. Returns null when any path escapes the project root, so
 * the caller fails closed (no receipt) rather than minting a misleading scope.
 */
function toRepositoryRelativePaths(
  projectRoot: string,
  values: readonly string[],
): string[] | null {
  const root = path.resolve(projectRoot).replaceAll('\\', '/').replace(/\/+$/, '');
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const slash = value.replaceAll('\\', '/').trim();
    if (!slash) continue;
    if (!/^(?:[A-Za-z]:|\/)/.test(slash)) {
      out.push(slash);
      continue;
    }
    const absolute = path.resolve(value).replaceAll('\\', '/');
    if (absolute === root) continue;
    if (!absolute.startsWith(`${root}/`)) return null;
    out.push(absolute.slice(root.length + 1));
  }
  return [...new Set(out)].sort();
}

/** Ledger slot identity: command fingerprint plus governed execution context. */
export function verifierReceiptLedgerKey(receipt: BoundChatVerifierReceipt): string {
  const commandKey = typeof receipt.command === 'string' ? verifierReceiptIdentityKey(receipt.command) : '@invalid-command';
  return JSON.stringify([commandKey, receipt.executionContext ?? null,
    receipt.working_directory ?? null, receipt.environment_policy ?? null, receipt.target ?? null]);
}

/** Preserve physical attempt history; replace only another projection of the same event. */
export function upsertVerifierReceipt(
  ledger: BoundChatVerifierReceipt[],
  receipt: BoundChatVerifierReceipt,
): void {
  const receiptKey = verifierReceiptLedgerKey(receipt);
  const existingIndex = ledger.findIndex(entry => verifierReceiptLedgerKey(entry) === receiptKey
    && (receipt.order ? entry.order?.sessionId === receipt.order.sessionId && entry.order.seq === receipt.order.seq : !entry.order));
  if (existingIndex >= 0) ledger[existingIndex] = receipt;
  else ledger.push(receipt);
}

/** Restore the durable verifier ledger and return its latest valid receipt. */
export function restorePersistedVerifierEvidence(
  log: SessionEventLog,
  ledger: BoundChatVerifierReceipt[],
  owner?: VerifierEvidenceOwner,
): BoundChatVerifierReceipt | null {
  let latest: BoundChatVerifierReceipt | null = null;
  for (const event of log.events) {
    if (event.kind !== 'verifier_attempt' || !event.receipt || event.authoritative !== true) continue;
    if (event.session_id !== log.session_id || !Number.isSafeInteger(event.seq) || event.seq < 0) continue;
    const context = event.receipt.executionContext;
    const knownOwner = context && [context.workspaceRoot, context.taskId, context.contractHash]
      .every(value => typeof value === 'string' && value.trim().length > 0);
    if (owner && (event.session_id !== owner.sessionId || (knownOwner
      && (context.workspaceRoot !== owner.workspaceRoot || context.taskId !== owner.taskId || context.contractHash !== owner.contractHash)))) continue;
    const restored = { ...event.receipt, order: { sessionId: event.session_id, seq: event.seq } };
    // Preserve malformed same-owner packets too: adaptation must report their
    // errors rather than silently deleting a possibly later failed attempt.
    if (!latest || restored.order.seq > latest.order!.seq) latest = restored;
    upsertVerifierReceipt(ledger, restored);
  }
  return latest;
}

/**
 * Caveats that keep a green exit from reading as test evidence it does not
 * carry. Uses only structured runner counts already on the receipt; counts
 * that are absent stay unknown (no output parsing, no speculation).
 */
export function verifierEvidenceCaveats(receipt: {
  exit_code: number;
  scope?: BoundChatVerifierReceipt['scope'];
  tests_total?: number;
  tests_skipped?: number;
}): string[] {
  const caveats: string[] = [];
  if (receipt.exit_code === 0 && receipt.tests_total === 0) {
    caveats.push(
      'verifier executed zero tests: a green exit with no tests is not test evidence',
    );
  }
  if (
    receipt.exit_code === 0 &&
    typeof receipt.tests_total === 'number' &&
    receipt.tests_total > 0 &&
    typeof receipt.tests_skipped === 'number' &&
    receipt.tests_skipped === receipt.tests_total
  ) {
    caveats.push('all reported tests were skipped: no test was actually executed');
  }
  return caveats;
}

/** Capture, persist, and cache one authoritative verifier result. */
export async function captureAndRecordVerifierReceipt(input: {
  projectRoot: string;
  command: string;
  exitCode: number;
  summary: string;
  stdout?: string;
  stderr?: string;
  mutationPaths: string[];
  allowRepositoryScopeForRedRecovery?: boolean;
  allowRepositoryScopeForGreenNoChange?: boolean;
  sessionEvents: SessionEventLog;
  turnId: string;
  ledger: BoundChatVerifierReceipt[];
  cache: Map<
    string,
    { receipt: BoundChatVerifierReceipt; writeCountAtCache: number; cwd?: string; envKey?: string }
  >;
  writeCount: number;
  toolCallId?: string;
  /** Composite cache slot identity; derived from command+cwd+env when omitted. */
  cacheIdentity?: { key: string; cwd: string; envKey: string };
  /** Host acceptance owner captured before dispatch, never supplied by the model. */
  verifierOwner?: VerifierEvidenceOwner;
  resolvedExecutable?: string;
  /** The command was not started. A synthetic exit must not enter the ledger. */
  simulated?: boolean;
  /** Recheck suspended execution ownership/candidate immediately before publishing evidence. */
  canPublish?: () => boolean;
}): Promise<BoundChatVerifierReceipt | null> {
  if (input.simulated === true) return null;
  const identity =
    input.cacheIdentity ??
    resolveVerifierCacheIdentity({
      projectRoot: input.projectRoot,
      command: input.command,
    });
  const relativeCwd =
    path.relative(input.projectRoot, identity.cwd).replaceAll('\\', '/') || '.';
  const commandIdentity = analyzeVerifierIdentity(input.command);
  const receipt = await captureChatVerifierReceipt({
    projectRoot: input.projectRoot,
    command: input.command,
    exitCode: input.exitCode,
    summary: input.summary,
    ...(input.stdout !== undefined ? { stdout: input.stdout } : {}),
    ...(input.stderr !== undefined ? { stderr: input.stderr } : {}),
    mutationPaths: input.mutationPaths,
    ...(input.allowRepositoryScopeForRedRecovery !== undefined
      ? { allowRepositoryScopeForRedRecovery: input.allowRepositoryScopeForRedRecovery }
      : {}),
    ...(input.allowRepositoryScopeForGreenNoChange !== undefined
      ? { allowRepositoryScopeForGreenNoChange: input.allowRepositoryScopeForGreenNoChange }
      : {}),
    ...(input.verifierOwner ? { executionContext: {
      workspaceRoot: input.verifierOwner.workspaceRoot,
      taskId: input.verifierOwner.taskId,
      contractHash: input.verifierOwner.contractHash,
      workingDirectory: identity.cwd,
      environmentFingerprint: identity.envKey,
      targetSelectors: commandIdentity?.targetSelectors ?? [],
      ...(input.resolvedExecutable ? { resolvedExecutable: input.resolvedExecutable } : {}),
    } } : {}),
    execution: {
      working_directory: relativeCwd,
      environment_policy: identity.envKey,
      ...(commandIdentity?.scope === 'targeted' && commandIdentity.targetSelectors.length > 0
        ? { target: commandIdentity.targetSelectors.join(',') }
        : {}),
    },
  });
  if (!receipt) return null;
  if (input.canPublish && !input.canPublish()) return null;
  const caveats = verifierEvidenceCaveats(receipt);
  if (caveats.length > 0 && !receipt.summary.includes(caveats[0]!)) {
    receipt.summary = [receipt.summary, ...caveats].join('\n');
  }
  const event = recordVerifierAttempt(input.sessionEvents, {
    turn_id: input.turnId,
    command_preview: input.command,
    authoritative: true,
    exit_code: input.exitCode,
    ...(input.toolCallId !== undefined ? { tool_call_id: input.toolCallId } : {}),
    receipt,
  });
  // The event wrapper is already serialized. Project its order onto a new
  // live receipt; restore reconstructs this same projection from the wrapper.
  const orderedReceipt = { ...receipt, order: { sessionId: event.session_id, seq: event.seq } };
  upsertVerifierReceipt(input.ledger, orderedReceipt);
  input.cache.set(identity.key, {
    receipt: orderedReceipt,
    writeCountAtCache: input.writeCount,
    cwd: identity.cwd,
    envKey: identity.envKey,
  });
  return orderedReceipt;
}

/** Cache entry contract for verifier-run dedup (see chatEngineContracts). */
export interface VerifierReceiptCacheEntry {
  receipt: BoundChatVerifierReceipt;
  writeCountAtCache: number;
  cwd: string;
  envKey: string;
}

/**
 * Identity of a verifier cache slot: the command's structural identity plus
 * the PHYSICAL working directory and an execution-environment fingerprint.
 * A cache keyed by the command string alone reuses a receipt captured in a
 * different directory or environment, which is not the same verification.
 */
export function resolveVerifierCacheIdentity(input: {
  projectRoot: string;
  command: string;
  cwd?: string;
  envKey?: string;
}): { key: string; cwd: string; envKey: string } {
  const cwd = path.resolve(input.projectRoot, input.cwd ?? '.');
  const envKey = input.envKey ?? verifierEnvironmentKey({ ...process.env, BABEL_PROJECT_ROOT: path.resolve(input.projectRoot) });
  return {
    key: `${verifierReceiptIdentityKey(input.command)}::cwd=${cwd}::env=${envKey}`,
    cwd,
    envKey,
  };
}

/**
 * Stable fingerprint of the execution environment a verifier would run in.
 * Every supplied variable contributes: the host cannot infer whether a custom
 * variable affects a project verifier. Only the aggregate digest is persisted;
 * variable names and values never appear in receipts.
 */
export function verifierEnvironmentKey(env: NodeJS.ProcessEnv = process.env): string {
  const relevant = JSON.stringify(Object.keys(env).sort().map(key => [key, env[key] ?? null]));
  return createHash('sha256').update(`${process.platform}\n${relevant}`).digest('hex');
}

/**
 * Decide whether a cached verifier receipt may be reused INSTEAD of executing.
 * Reuse requires the same write count AND the receipt's bound workspace
 * revision to still match the live tree: some shell actions mark receipts
 * stale without bumping writeCount, so the counter alone can authorize a
 * stale rerun-skip. An unevaluable or moved revision must execute (fail
 * closed). Same-state reuse stays legitimate.
 */
export function shouldReuseCachedVerifierReceipt(
  projectRoot: string,
  receipt: BoundChatVerifierReceipt,
): boolean {
  if (receipt.inputClosure?.mode === 'unsupported'
    || receipt.inputClosure?.reuseEligible === false) return false;
  const currency = evaluateChatVerifierReceiptCurrencySync(projectRoot, receipt);
  return currency !== null && currency.stale === false;
}

function verifierReceiptIdentityKey(command: string): string {
  // Execution identity, NOT coverage identity: the structural identityKey
  // collapses argument detail by design (coverage matching), which would
  // alias distinct executions (pytest -m slow vs pytest -m fast, npm test vs
  // npm test -- --coverage) into one cache slot / ledger entry. The
  // fingerprint preserves executable, argument order, values and quoting.
  return (
    verifierExecutionFingerprint(command) ||
    command.trim().replace(/\s+/g, ' ')
  );
}

export function prepareKernelVerifierInput(
  lastVerifierReceipt: BoundChatVerifierReceipt | null,
  executedVerifierLedger?: readonly BoundChatVerifierReceipt[] | null,
): {
  lastVerifierReceipt: ExecutorVerifierReceipt | null;
  executedVerifierLedger: ExecutorVerifierReceipt[] | null;
  verifierEvidenceErrors: string[];
} {
  const hasExplicitLedger = executedVerifierLedger !== undefined && executedVerifierLedger !== null;
  const errors: string[] = [];
  let adaptedLast: ExecutorVerifierReceipt | null = null;
  if (lastVerifierReceipt) {
    const res = toExecutorVerifierReceipt(lastVerifierReceipt);
    if (res.ok) {
      adaptedLast = res.receipt;
    } else if (!hasExplicitLedger) {
      // With no canonical ledger, the legacy last receipt is the only evidence
      // available and its adaptation failure must fail closed. With an explicit
      // ledger, lastVerifierReceipt is display/backward-compatibility state only.
      errors.push(...res.errors);
    }
  }

  const adaptedLedger = hasExplicitLedger ? [] as ExecutorVerifierReceipt[] : null;
  if (hasExplicitLedger) {
    for (const receipt of executedVerifierLedger ?? []) {
      const res = toExecutorVerifierReceipt(receipt);
      if (res.ok) {
        adaptedLedger!.push(res.receipt);
      } else {
        errors.push(...res.errors);
      }
    }
  }

  return {
    lastVerifierReceipt: hasExplicitLedger ? null : adaptedLast,
    executedVerifierLedger: adaptedLedger,
    verifierEvidenceErrors: errors,
  };
}

export { toExecutorVerifierReceipt } from '../evidence/chatRevisionBinding.js';
