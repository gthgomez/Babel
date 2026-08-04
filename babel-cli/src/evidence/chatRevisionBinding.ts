/**
 * Chat-path revision binding for verifier receipts (H7/H8).
 *
 * Wires existing RevisionManager into ChatEngine without pulling IndependentVerifier
 * (full tree copy) onto the hot completion path.
 */

import type { VerifierAuthoritySource } from '../executor/contracts.js';
import {
  RevisionManager,
  type RevisionBoundReceipt,
  type WorkspaceRevision,
} from './revisionBoundReceipt.js';

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
