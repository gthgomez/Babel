/**
 * Chat-path revision binding for verifier receipts (H7/H8).
 *
 * IndependentVerifier (full tree copy) stays off the default hot path.
 * Enable with BABEL_INDEPENDENT_VERIFIER=1 (see independentVerifier.ts).
 */

import type { VerifierAuthoritySource } from '../executor/contracts.js';
import {
  evaluateCompletionEvidenceSync,
  type CompletionEvidenceEvaluation,
} from './completionEvidence.js';
import { EvidenceGraph } from './evidenceGraph.js';
import { independentVerifierProofErrors } from './independentVerifier.js';
import {
  RevisionManager,
  type RevisionBoundReceipt,
  type WorkspaceRevision,
} from './revisionBoundReceipt.js';

/** Canonical claim id for Chat-produced evidence graphs. */
export const CHAT_EVIDENCE_CLAIM_ID = 'chat-claim' as const;

/** Chat verifier receipt with optional durable workspace binding. */
export type BoundChatVerifierReceipt = {
  command: string;
  exit_code: number;
  summary: string;
  stale?: boolean;
  staleReason?: string;
  receiptId?: string;
  boundRevision?: WorkspaceRevision;
  verifier_id?: string;
  authority_source?: VerifierAuthoritySource;
  argv?: string[];
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
  );
  return {
    command: input.command,
    exit_code: input.exit_code,
    summary: input.summary,
    stale: false,
    receiptId: `receipt-${Date.now()}`,
    boundRevision,
    ...(input.structured
      ? {
          verifier_id: input.structured.verifierId,
          authority_source: input.structured.authoritySource,
          argv: [input.structured.executable, ...input.structured.args],
        }
      : {}),
  };
}

/** Convert a chat receipt into the RevisionBoundReceipt shape used by RevisionManager. */
export function toRevisionBoundReceipt(
  receipt: BoundChatVerifierReceipt,
): RevisionBoundReceipt | null {
  if (!receipt.boundRevision) return null;
  return {
    receiptId: receipt.receiptId ?? 'chat-receipt',
    command: receipt.command,
    exitCode: receipt.exit_code,
    boundRevision: receipt.boundRevision,
    stale: receipt.stale === true,
    authority: true,
    ...(receipt.authority_source
      ? { authoritySource: receipt.authority_source }
      : {}),
    ...(receipt.staleReason ? { staleReason: receipt.staleReason } : {}),
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
  const result = RevisionManager.isReceiptStaleSync(bound, projectRoot);
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
  }[],
): {
  tool: string;
  target: string;
  detail?: string;
  error?: string;
  exit_code?: number;
}[] {
  return log.map((entry) => ({
    tool: entry.tool,
    target: entry.target ?? '',
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.exit_code !== undefined ? { exit_code: entry.exit_code } : {}),
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
  if (receipt && receipt.exit_code === 0) {
    const mutationPaths = mutationPathsFromSessionEvents(input.events);
    for (const err of independentVerifierProofErrors({
      projectRoot: input.projectRoot,
      command: receipt.command,
      exitCode: receipt.exit_code,
      mutationPaths,
      ...(input.env !== undefined ? { env: input.env } : {}),
    })) {
      if (!errors.includes(err)) errors.push(err);
    }
  }

  return errors.length === 0 ? { compliant: true } : { compliant: false, errors };
}
