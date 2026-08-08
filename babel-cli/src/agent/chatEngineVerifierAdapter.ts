/**
 * Verifier preparation and required-command resolution helper for ChatEngine.
 */
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
}): Promise<BoundChatVerifierReceipt | null> {
  if (!isAuthoritativeVerifierCommand(input.command)) return null;
  const parsed = parseStructuredVerifierCommand(input.command, {
    authoritySource: 'built_in_runner',
  });
  if (!parsed || !isVerifierAuthoritySource(parsed.authoritySource)) return null;
  return bindChatVerifierReceipt({
    projectRoot: input.projectRoot,
    command: input.command,
    exit_code: input.exitCode,
    summary: input.summary,
    mutationPaths: input.mutationPaths,
    structured: {
      verifierId: parsed.verifierId,
      authoritySource: parsed.authoritySource,
      executable: parsed.executable,
      args: parsed.args,
    },
  });
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
  sessionEvents: SessionEventLog;
  turnId: string;
  ledger: BoundChatVerifierReceipt[];
  cache: Map<string, { receipt: BoundChatVerifierReceipt; writeCountAtCache: number }>;
  writeCount: number;
}): Promise<BoundChatVerifierReceipt | null> {
  const receipt = await captureChatVerifierReceipt(input);
  if (!receipt) return null;
  upsertVerifierReceipt(input.ledger, receipt);
  recordVerifierAttempt(input.sessionEvents, {
    turn_id: input.turnId,
    command_preview: input.command,
    authoritative: true,
    exit_code: input.exitCode,
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
