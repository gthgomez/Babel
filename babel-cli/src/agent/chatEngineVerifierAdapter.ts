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
