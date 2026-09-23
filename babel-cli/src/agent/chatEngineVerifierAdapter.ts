/**
 * Verifier preparation and required-command resolution helper for ChatEngine.
 */
import path from 'node:path';

import {
  bindChatVerifierReceipt,
  toExecutorVerifierReceipt,
  type BoundChatVerifierReceipt,
} from '../evidence/chatRevisionBinding.js';
import {
  isVerifierAuthoritySource,
  type ExecutorVerifierReceipt,
} from '../executor/contracts.js';
import {
  recordVerifierAttempt,
  type SessionEventLog,
} from './sessionEvents.js';
import { analyzeVerifierIdentity } from '../services/verifierIdentity.js';
import {
  isAuthoritativeVerifierCommand,
  parseStructuredVerifierCommand,
  resolveHonestyRequiredVerifiers,
} from './completionGatePolicy.js';

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
  mutationPaths: string[];
  /** Explicit red-only baseline route; cannot satisfy a green completion. */
  allowRepositoryScopeForRedRecovery?: boolean;
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
  const repositoryScopedRed = input.allowRepositoryScopeForRedRecovery === true &&
    input.exitCode !== 0 && mutationPaths.length === 0;
  const receipt = await bindChatVerifierReceipt({
    projectRoot: input.projectRoot,
    command: input.command,
    exit_code: input.exitCode,
    summary: input.summary,
    mutationPaths,
    ...(repositoryScopedRed ? { scopeKind: 'repository' as const } : {}),
    structured: {
      verifierId: parsed.verifierId,
      authoritySource: parsed.authoritySource,
      executable: parsed.executable,
      args: parsed.args,
    },
  });
  // Repository scope falls back to a root-path digest without a Git commit.
  // That is insufficient evidence for a red baseline repair candidate.
  if (repositoryScopedRed && !receipt.boundRevision?.gitCommitHash) return null;
  return receipt;
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

/** Replace the latest ledger entry for a structural verifier identity. */
export function upsertVerifierReceipt(
  ledger: BoundChatVerifierReceipt[],
  receipt: BoundChatVerifierReceipt,
): void {
  const receiptKey = verifierReceiptIdentityKey(receipt.command);
  const existingIndex = ledger.findIndex(
    (entry) => verifierReceiptIdentityKey(entry.command) === receiptKey,
  );
  if (existingIndex >= 0) ledger[existingIndex] = receipt;
  else ledger.push(receipt);
}

/** Restore the durable verifier ledger and return its latest valid receipt. */
export function restorePersistedVerifierEvidence(
  log: SessionEventLog,
  ledger: BoundChatVerifierReceipt[],
): BoundChatVerifierReceipt | null {
  let latest: BoundChatVerifierReceipt | null = null;
  for (const event of log.events) {
    if (event.kind !== 'verifier_attempt' || !event.receipt) continue;
    if (!toExecutorVerifierReceipt(event.receipt).ok) continue;
    latest = event.receipt;
    upsertVerifierReceipt(ledger, event.receipt);
  }
  return latest;
}

/** Capture, persist, and cache one authoritative verifier result. */
export async function captureAndRecordVerifierReceipt(input: {
  projectRoot: string;
  command: string;
  exitCode: number;
  summary: string;
  mutationPaths: string[];
  allowRepositoryScopeForRedRecovery?: boolean;
  sessionEvents: SessionEventLog;
  turnId: string;
  ledger: BoundChatVerifierReceipt[];
  cache: Map<string, { receipt: BoundChatVerifierReceipt; writeCountAtCache: number }>;
  writeCount: number;
  toolCallId?: string;
}): Promise<BoundChatVerifierReceipt | null> {
  const receipt = await captureChatVerifierReceipt(input);
  if (!receipt) return null;
  upsertVerifierReceipt(input.ledger, receipt);
  recordVerifierAttempt(input.sessionEvents, {
    turn_id: input.turnId,
    command_preview: input.command,
    authoritative: true,
    exit_code: input.exitCode,
    ...(input.toolCallId !== undefined ? { tool_call_id: input.toolCallId } : {}),
    receipt,
  });
  input.cache.set(input.command, { receipt, writeCountAtCache: input.writeCount });
  return receipt;
}

function verifierReceiptIdentityKey(command: string): string {
  return analyzeVerifierIdentity(command)?.identityKey ?? command.trim().replace(/\s+/g, ' ');
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
