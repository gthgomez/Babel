/**
 * Chat-path revision binding for verifier receipts (H7/H8).
 *
 * IndependentVerifier (full tree copy) stays off the default Chat hot path
 * (safe_repo). Enable with BABEL_INDEPENDENT_VERIFIER=1 or high-assurance
 * execution profiles (see independentVerifier.ts).
 */

import {
  isVerifierAuthoritySource,
  type ExecutorVerifierReceipt,
  type VerifierAuthoritySource,
  type WorkspaceRevisionIdentity,
} from '../executor/contracts.js';
import {
  evaluateCompletionEvidenceSync,
  type CompletionEvidenceEvaluation,
} from './completionEvidence.js';
import { EvidenceGraph } from './evidenceGraph.js';
import { independentVerifierProofErrors } from './independentVerifier.js';
import { discoverVerifierInputClosure } from './revisionBoundReceipt.js';
import { analyzeVerifierIdentity } from '../services/verifierIdentity.js';
import {
  compareRevisions,
  RevisionManager,
  type GitBindingModeV1,
  type RevisionBoundReceipt,
  type WorkspaceRevision,
} from './revisionBoundReceipt.js';

/** Canonical claim id for Chat-produced evidence graphs. */
export const CHAT_EVIDENCE_CLAIM_ID = 'chat-claim' as const;

/** Chat verifier receipt with optional durable workspace binding. */
export type BoundChatVerifierReceipt = {
  command: string;
  exit_code: number;
  exitCode?: number;
  summary: string;
  stale?: boolean;
  staleReason?: string;
  receiptId?: string;
  boundRevision?: WorkspaceRevision;
  verifier_id?: string;
  verifierId?: string;
  authority_source?: VerifierAuthoritySource;
  authoritySource?: VerifierAuthoritySource;
  authority?: boolean;
  capturedAt?: number;
  argv?: string[];
  /**
   * H5: verifier scope. Must be preserved into completion promotion —
   * never silently upgraded from targeted → full_suite.
   */
  scope?: 'full_suite' | 'targeted' | 'smoke' | 'property' | 'security';
  tests_total?: number;
  tests_passed?: number;
  tests_failed?: number;
  tests_skipped?: number;
  /** Present only when capture established a relevant-input closure. */
  inputClosure?: { mode: "bound"; paths: string[]; digests: Record<string, string>; reuseEligible?: false } | { mode: "unsupported"; reason: string };
};

/** Collect unique mutation paths from SessionEventV1 mutation_batch events. */
export function mutationPathsFromSessionEvents(
  events: readonly { kind: string; paths?: readonly string[] }[],
): string[] {
  const set = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'mutation_batch' || !event.paths) continue;
    for (const p of event.paths) {
      if (typeof p === 'string' && p.length > 0) set.add(p);
    }
  }
  return [...set].sort();
}

/** Bind a live verifier attempt to current workspace revision (async capture path). */
export async function bindChatVerifierReceipt(input: {
  projectRoot: string;
  command: string;
  exit_code: number;
  summary: string;
  mutationPaths: string[];
  scopeKind?: 'files' | 'repository';
  gitBinding?: GitBindingModeV1;
  structured?: {
    verifierId: string;
    authoritySource: VerifierAuthoritySource;
    executable: string;
    args: string[];
  } | null;
}): Promise<BoundChatVerifierReceipt> {
  const boundRevision = await RevisionManager.computeRevision(
    input.projectRoot,
    input.mutationPaths,
    {
      scope_kind: input.scopeKind ?? 'files',
      ...(input.gitBinding ? { git_binding: input.gitBinding } : {}),
    },
  );
  const now = Date.now();
  const identity = analyzeVerifierIdentity(input.command);
  const executionScope = identity?.scope === 'full'
    ? 'full_suite' as const
    : identity?.scope === 'targeted'
      ? 'targeted' as const
      : undefined;
  return {
    command: input.command,
    exit_code: input.exit_code,
    exitCode: input.exit_code,
    summary: input.summary,
    stale: false,
    receiptId: `receipt-${now}`,
    capturedAt: now,
    ...(executionScope ? { scope: executionScope } : {}),
    authority: input.structured !== undefined && input.structured !== null,
    boundRevision,
    ...(input.structured
      ? {
          verifier_id: input.structured.verifierId,
          verifierId: input.structured.verifierId,
          authority_source: input.structured.authoritySource,
          authoritySource: input.structured.authoritySource,
          argv: [input.structured.executable, ...input.structured.args],
        }
      : {}),
  };
}

/** Convert a chat receipt into the RevisionBoundReceipt shape used by RevisionManager. */
export function toRevisionBoundReceipt(
  receipt: BoundChatVerifierReceipt,
): RevisionBoundReceipt | null {
  if (!receipt.boundRevision || !receipt.receiptId || receipt.receiptId.trim().length === 0) return null;
  return {
    receiptId: receipt.receiptId,
    command: receipt.command,
    exitCode: receipt.exit_code,
    boundRevision: receipt.boundRevision,
    stale: receipt.stale === true,
  };
}

/**
 * Authoritative re-evaluation of a verifier receipt's currency against the
 * CURRENT workspace state, using the receipt's own bound revision scope.
 *
 * The in-memory `stale` flag is a one-way conservative ratchet: any
 * subsequent tool that cannot PROVE its workspace effect (an unconfirmed
 * direct mutation, a non-verifier shell command such as `cat`) permanently
 * marks the receipt stale, even when the workspace bytes are provably
 * unchanged. For an install boundary that requires a live receipt, that
 * ratchet deadlocks the turn: the receipt is stale, so no context checkpoint
 * installs, so every later dispatch is refused — and the model can never
 * re-run its verifier because dispatch never happens again.
 *
 * This function re-derives staleness from evidence instead of the flag: it
 * recomputes the revision for the receipt's OWN bound scope and compares it
 * to the bound revision. Unchanged ⇒ the receipt is factually current
 * (stale=false). Changed ⇒ stale (fail-closed, exactly as before). A receipt
 * with no evaluable bound revision returns null so callers fall back to the
 * conservative flag. This narrows the staleness heuristic to what it can
 * actually prove; it never marks a changed workspace as current.
 */
export function evaluateChatVerifierReceiptCurrencySync(
  projectRoot: string,
  receipt: BoundChatVerifierReceipt | null | undefined,
): { stale: boolean; reason?: string } | null {
  if (!receipt) return null;
  if (receipt.inputClosure?.mode === 'unsupported') {
    return { stale: true, reason: receipt.inputClosure.reason || 'Verifier input closure is unsupported' };
  }
  if (receipt.inputClosure?.mode === 'bound') {
    const freshClosure = discoverVerifierInputClosure(projectRoot, receipt.inputClosure.reuseEligible === false);
    if (freshClosure.mode !== 'bound') {
      return { stale: true, reason: freshClosure.reason };
    }
    if (freshClosure.paths.join('\n') !== receipt.inputClosure.paths.join('\n')) {
      return { stale: true, reason: 'Verifier input closure changed' };
    }
    const boundDigests = receipt.inputClosure.digests;
    if (!boundDigests) {
      return { stale: true, reason: 'Verifier input closure has no content digests' };
    }
    for (const rel of freshClosure.paths) {
      if (freshClosure.digests[rel] !== boundDigests[rel]) {
        return { stale: true, reason: `Verifier input changed: ${rel}` };
      }
    }
  }
  const bound = toRevisionBoundReceipt(receipt);
  const revision = receipt.boundRevision;
  if (!bound || !revision || !revision.scope || !revision.gitBinding) return null;
  if (revision.scope.kind === 'repository' && revision.gitBinding !== 'required') {
    return { stale: true, reason: 'Repository content revision is unavailable' };
  }
  const paths = revision.scope.kind === 'files' ? revision.scope.paths : [];
  let fresh: WorkspaceRevision;
  try {
    fresh = RevisionManager.computeRevisionSync(projectRoot, paths, {
      scope_kind: revision.scope.kind,
      git_binding: revision.scope.kind === 'repository' ? 'required' : revision.gitBinding,
    });
  } catch {
    if (revision.scope.kind === 'repository') {
      return { stale: true, reason: 'Repository content revision is unavailable' };
    }
    return null;
  }
  return compareRevisions(revision, fresh);
}

/**
 * Adapt a Chat-layer BoundChatVerifierReceipt into a strict canonical ExecutorVerifierReceipt.
 * Returns fallible result: never fabricates missing revision, receipt ID, or authority.
 */
export function toExecutorVerifierReceipt(
  chatReceipt: BoundChatVerifierReceipt | null | undefined,
): { ok: true; receipt: ExecutorVerifierReceipt } | { ok: false; errors: string[] } {
  if (!chatReceipt || typeof chatReceipt !== 'object') {
    return { ok: false, errors: ['Chat verifier receipt is null or undefined'] };
  }

  const errors: string[] = [];
  const command = chatReceipt.command;
  if (typeof command !== 'string' || command.trim().length === 0) {
    errors.push('Missing or invalid verifier command');
  }

  const exitCode = chatReceipt.exitCode ?? chatReceipt.exit_code;
  if (typeof exitCode !== 'number' || !Number.isFinite(exitCode)) {
    errors.push('Missing or invalid exit code');
  }

  const receiptId = chatReceipt.receiptId;
  if (typeof receiptId !== 'string' || receiptId.trim().length === 0) {
    errors.push('Missing receiptId on verifier receipt');
  }

  if (chatReceipt.authority !== true) {
    errors.push('Verifier receipt authority must be explicitly true');
  }

  const capturedAt = chatReceipt.capturedAt;
  if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt) || capturedAt <= 0) {
    errors.push('Missing or non-finite positive capturedAt timestamp on verifier receipt');
  }

  const authoritySource = chatReceipt.authoritySource ?? chatReceipt.authority_source;
  if (!isVerifierAuthoritySource(authoritySource)) {
    errors.push(`Invalid or missing authoritySource provenance: '${String(authoritySource)}'`);
  }

  if (chatReceipt.stale !== undefined && typeof chatReceipt.stale !== 'boolean') {
    errors.push('stale must be a boolean when present');
  }

  const verifierId = chatReceipt.verifierId ?? chatReceipt.verifier_id;
  if (typeof verifierId !== 'string' || verifierId.trim().length === 0) {
    errors.push('Missing verifierId on verifier receipt');
  }

  const revision = chatReceipt.boundRevision;
  const rawRevision = revision as unknown as Record<string, unknown> | undefined;
  const rawScope = rawRevision?.['scope'];
  if (
    rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope) &&
    (rawScope as Record<string, unknown>)['kind'] === 'repository' &&
    (rawRevision?.['gitCommitHash'] == null || rawRevision?.['gitBinding'] !== 'required')
  ) {
    errors.push('Repository-scoped verifier evidence requires a content-bound Git tree');
  }
  const boundRevision = validateWorkspaceRevisionIdentity(revision, errors);
  const counts: Pick<ExecutorVerifierReceipt, 'tests_total' | 'tests_passed' | 'tests_failed' | 'tests_skipped'> = {};
  for (const key of ['tests_total', 'tests_passed', 'tests_failed', 'tests_skipped'] as const) {
    const count = chatReceipt[key];
    if (count === undefined) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      errors.push(`Invalid ${key}: expected a nonnegative safe integer`);
    } else counts[key] = count;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    receipt: {
      receiptId: receiptId as string,
      verifierId: verifierId as string,
      command: command as string,
      exitCode: exitCode!,
      authority: true,
      authoritySource: authoritySource as VerifierAuthoritySource,
      boundRevision,
      capturedAt: capturedAt!,
      stale: chatReceipt.stale === true,
      ...(chatReceipt.staleReason ? { staleReason: chatReceipt.staleReason } : {}),
      ...(chatReceipt.scope ? { scope: chatReceipt.scope } : {}),
      ...counts,
    },
  };
}

function validateWorkspaceRevisionIdentity(
  value: WorkspaceRevision | undefined,
  errors: string[],
): WorkspaceRevisionIdentity {
  if (!value || typeof value !== 'object') {
    errors.push('Missing or invalid boundRevision on verifier receipt');
    return {
      gitCommitHash: null,
      compositeTreeHash: '',
      fileHashes: {},
      capturedAt: 0,
    };
  }

  const revision = value as unknown as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(revision, 'gitCommitHash')) {
    errors.push('boundRevision.gitCommitHash is required; no commit value may be synthesized');
  } else if (
    revision['gitCommitHash'] !== null &&
    (typeof revision['gitCommitHash'] !== 'string' || revision['gitCommitHash'].trim().length === 0)
  ) {
    errors.push('boundRevision.gitCommitHash must be null or a non-empty string');
  }

  const compositeTreeHash = revision['compositeTreeHash'];
  if (typeof compositeTreeHash !== 'string' || compositeTreeHash.trim().length === 0) {
    errors.push('boundRevision.compositeTreeHash is required and must be a non-empty string');
  }

  const rawFileHashes = revision['fileHashes'];
  const fileHashes: Record<string, string> = {};
  if (!rawFileHashes || typeof rawFileHashes !== 'object' || Array.isArray(rawFileHashes)) {
    errors.push('boundRevision.fileHashes must be an object containing only non-empty hash values');
  } else {
    for (const [file, hash] of Object.entries(rawFileHashes)) {
      if (file.trim().length === 0) {
        errors.push('boundRevision.fileHashes contains an empty file key');
      }
      if (typeof hash !== 'string' || hash.trim().length === 0) {
        errors.push(`boundRevision.fileHashes[${JSON.stringify(file)}] must be a non-empty string`);
      } else {
        fileHashes[file] = hash;
      }
    }
  }

  const capturedAt = revision['capturedAt'];
  if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt) || capturedAt <= 0) {
    errors.push('boundRevision.capturedAt is required and must be a finite positive number');
  }

  return {
    gitCommitHash: revision['gitCommitHash'] === null ? null : String(revision['gitCommitHash'] ?? ''),
    compositeTreeHash: typeof compositeTreeHash === 'string' ? compositeTreeHash : '',
    fileHashes,
    capturedAt: typeof capturedAt === 'number' ? capturedAt : 0,
  };
}

/**
 * Sync re-check at Chat finalize: if bound files or git HEAD moved after the
 * green verifier, mark receipt.stale so honesty + proof refuse VERIFIED_COMPLETE.
 * Mutates receipt in place when boundRevision is present.
 */
export function refreshChatVerifierReceiptStalenessSync(
  projectRoot: string,
  receipt: BoundChatVerifierReceipt | null | undefined,
): BoundChatVerifierReceipt | null | undefined {
  if (!receipt || receipt.stale) return receipt;
  const bound = toRevisionBoundReceipt(receipt);
  if (!bound) return receipt;
  const result = evaluateChatVerifierReceiptCurrencySync(projectRoot, receipt) ?? {
    stale: true,
    reason: 'Receipt has no evaluable revision scope or Git binding',
  };
  if (result.stale) {
    receipt.stale = true;
    if (result.reason) receipt.staleReason = result.reason;
  }
  return receipt;
}

/** Proof errors for revision-bound receipts (shared by Chat buildCompletionProof). */
export function revisionBindingProofErrors(
  receipt: BoundChatVerifierReceipt | null | undefined,
): string[] {
  if (!receipt) return ['missing green verifier receipt'];
  if (receipt.stale) {
    return [
      receipt.staleReason
        ? `verifier receipt is stale: ${receipt.staleReason}`
        : 'verifier receipt is stale',
    ];
  }
  if (!receipt.boundRevision) {
    return ['missing revision-bound verifier receipt'];
  }
  return [];
}

/** ExactOptionalPropertyTypes-safe gate log projection (shared by streamDone/buildResult). */
export function toGateToolLog(
  log: readonly {
    tool: string;
    target?: string;
    detail?: string;
    error?: string;
    exit_code?: number;
    mutation_paths?: string[];
  }[],
): {
  tool: string;
  target: string;
  detail?: string;
  error?: string;
  exit_code?: number;
  mutation_paths?: string[];
}[] {
  return log.map((entry) => ({
    tool: entry.tool,
    target: entry.target ?? '',
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.exit_code !== undefined ? { exit_code: entry.exit_code } : {}),
    ...(entry.mutation_paths !== undefined ? { mutation_paths: [...entry.mutation_paths] } : {}),
  }));
}

/**
 * Build the lightweight EvidenceGraph Chat feeds into kernel evaluateEvidence.
 * Uses SessionEventV1 mutation_batch paths + the bound Chat verifier receipt.
 */
export function buildChatEvidenceGraph(input: {
  receipt: BoundChatVerifierReceipt | null | undefined;
  mutationPaths: string[];
  hasMutation: boolean;
  claimId?: string;
}): EvidenceGraph {
  const claimId = input.claimId ?? CHAT_EVIDENCE_CLAIM_ID;
  const graph = new EvidenceGraph();
  graph.addNode({
    id: claimId,
    type: 'claim',
    data: { source: 'chat' },
    parents: [],
  });

  if (input.hasMutation) {
    graph.addNode({
      id: 'chat-patch',
      type: 'patch',
      data: { paths: input.mutationPaths },
      parents: [claimId],
    });
  }

  const bound = input.receipt ? toRevisionBoundReceipt(input.receipt) : null;
  if (bound && input.receipt && input.receipt.exit_code === 0) {
    graph.addNode({
      id: bound.receiptId,
      type: 'verifier_receipt',
      data: bound,
      parents: [claimId],
    });
  }

  return graph;
}

/** Run kernel-equivalent evidence evaluation for Chat proof (sync). */
export function evaluateChatEvidenceGraph(input: {
  projectRoot: string;
  receipt: BoundChatVerifierReceipt | null | undefined;
  events: readonly {
    kind: string;
    paths?: readonly string[];
    authoritative?: boolean;
    exit_code?: number;
  }[];
  hasMutation: boolean;
}): CompletionEvidenceEvaluation {
  const mutationPaths = mutationPathsFromSessionEvents(input.events);
  const graph = buildChatEvidenceGraph({
    receipt: input.receipt,
    mutationPaths,
    hasMutation: input.hasMutation,
  });
  return evaluateCompletionEvidenceSync({
    projectRoot: input.projectRoot,
    graph,
    contract: {
      taskClaimId: CHAT_EVIDENCE_CLAIM_ID,
      requiredEvidenceTypes: input.hasMutation
        ? ['patch', 'verifier_receipt']
        : ['verifier_receipt'],
    },
  });
}

/**
 * Full Chat proof surface: structural checks + shared evaluateEvidence authority.
 * Extracted so ChatEngine stays under the file-size ratchet.
 */
export function evaluateChatCompletionProof(input: {
  projectRoot: string;
  hasMutation: boolean;
  verifierTampered: boolean;
  receipt: BoundChatVerifierReceipt | null | undefined;
  events: readonly {
    kind: string;
    paths?: readonly string[];
    authoritative?: boolean;
    exit_code?: number;
  }[];
  isAuthoritativeCommand: (command: string) => boolean;
  /** Optional env override for IndependentVerifier opt-in tests. */
  env?: NodeJS.ProcessEnv;
  /**
   * Optional execution profile name for IndependentVerifier profile defaults.
   * When omitted, independentVerifierProofErrors reads BABEL_EXECUTION_PROFILE
   * from env (or process.env when env is also omitted).
   */
  executionProfile?: string;
}): { compliant: boolean; errors?: string[] } {
  const errors: string[] = [];
  if (!input.hasMutation) errors.push('missing production mutation evidence');
  if (input.verifierTampered) errors.push('verifier integrity violation');

  const receipt = input.receipt;
  if (!receipt || receipt.exit_code !== 0) {
    errors.push('missing green verifier receipt');
  } else if (!input.isAuthoritativeCommand(receipt.command)) {
    errors.push('verifier receipt is not authoritative');
  } else if (!receipt.verifier_id || !receipt.argv) {
    errors.push('verifier receipt is not durably structured');
  } else {
    errors.push(...revisionBindingProofErrors(receipt));
  }

  if (!input.events.some((event) => event.kind === 'mutation_batch')) {
    errors.push('missing mutation transaction evidence');
  }
  if (
    !input.events.some(
      (event) =>
        event.kind === 'verifier_attempt' &&
        event.authoritative &&
        event.exit_code === 0,
    )
  ) {
    errors.push('missing canonical verifier-attempt evidence');
  }

  // Shared kernel evidence authority (contract coverage + revision-bound graph).
  const evidence = evaluateChatEvidenceGraph({
    projectRoot: input.projectRoot,
    receipt: input.receipt,
    events: input.events,
    hasMutation: input.hasMutation,
  });
  for (const missing of evidence.missing) {
    errors.push(`missing evidence: ${missing}`);
  }
  for (const err of evidence.errors) {
    if (!errors.includes(err)) errors.push(err);
  }

  // Opt-in clean-room IndependentVerifier (default off — no hot-path tree copy).
  // High-assurance profiles may default ON; env still overrides.
  if (receipt && receipt.exit_code === 0) {
    const mutationPaths = mutationPathsFromSessionEvents(input.events);
    const env = input.env ?? process.env;
    const executionProfile =
      input.executionProfile ?? env['BABEL_EXECUTION_PROFILE'];
    for (const err of independentVerifierProofErrors({
      projectRoot: input.projectRoot,
      command: receipt.command,
      exitCode: receipt.exit_code,
      mutationPaths,
      env,
      ...(executionProfile !== undefined ? { profile: executionProfile } : {}),
    })) {
      if (!errors.includes(err)) errors.push(err);
    }
  }

  return errors.length === 0 ? { compliant: true } : { compliant: false, errors };
}
