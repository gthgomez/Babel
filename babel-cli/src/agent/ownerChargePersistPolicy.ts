import type { ChatAllowanceCostCap } from './chatEngineContracts.js'
import type { OwnerAccountingFault } from './chatEngineOwnerAccounting.js'

/** Filesystem journal failures on owner-charge receipt writes (not authority/settlement). */
export function isOwnerChargeJournalIoError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'EPERM' || code === 'ENOSPC' || code === 'EIO'
}

export function isOwnerChargeAuthorityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message === 'Owner charge receipts are incomplete'
}

export function ownerChargePersistBlocksRuntime(
  error: unknown,
  costCap: ChatAllowanceCostCap,
): boolean {
  if (costCap.kind === 'finite') return true
  if (isOwnerChargeJournalIoError(error)) return false
  return true
}

export const OWNER_CHARGE_JOURNAL_UNAVAILABLE_REASON =
  'Owner charge journal unavailable; telemetry may be unpersisted'

export function ownerChargePersistFailureReason(
  error: unknown,
  blocksRuntime: boolean,
): string {
  if (!blocksRuntime) return OWNER_CHARGE_JOURNAL_UNAVAILABLE_REASON
  return error instanceof Error ? error.message : String(error)
}

export interface OwnerChargePersistFaultHost {
  taskAllowance: { grant?: { costCap: ChatAllowanceCostCap }; taskOwnerId: string } | null;
  recordOwnerAccountingFault(
    scope: import('./chatEngineProviderAccounting.js').ChatUsageScope,
    kind: OwnerAccountingFault['kind'],
    reason: string,
    appliesToCurrent: boolean,
    blocksRuntimeAuthority?: boolean,
  ): void;
}

/** Record a persist failure and return whether runtime authority must block. */
export function handleOwnerChargePersistFailure(
  host: OwnerChargePersistFaultHost,
  scope: import('./chatEngineProviderAccounting.js').ChatUsageScope,
  error: unknown,
  appliesToCurrent: boolean,
): boolean {
  const costCap = host.taskAllowance?.grant?.costCap ?? { kind: 'finite', usd: 0 };
  const blocks = ownerChargePersistBlocksRuntime(error, costCap);
  host.recordOwnerAccountingFault(
    scope,
    'persistence-failure',
    ownerChargePersistFailureReason(error, blocks),
    appliesToCurrent,
    blocks,
  );
  return blocks;
}

export function ownerAccountingFaultBlocksRuntime(
  fault: OwnerAccountingFault,
  costCap: ChatAllowanceCostCap,
): boolean {
  if (fault.kind === 'settlement-conflict') return true
  if (fault.kind !== 'persistence-failure') return true
  if (costCap.kind === 'finite') return true
  return fault.reason !== OWNER_CHARGE_JOURNAL_UNAVAILABLE_REASON
}
