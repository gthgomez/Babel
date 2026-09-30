import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { globalCostTracker, type ChargeReceipt } from '../services/costTracker.js';
import type { ChatTaskAllowanceSnapshot } from './chatEngine.js';
import type { ChatUsageScope } from './chatEngineProviderAccounting.js';

export interface OwnerAccountingFault {
  taskOwnerId: string;
  ownerGeneration: number | null;
  accountingEpoch: string;
  chargeId: string | null;
  persistenceScope: 'owner-charge-receipt';
  kind: 'settlement-conflict' | 'persistence-failure';
  reason: string;
}

export interface ChatEngineOwnerAccountingHost {
  readonly engineRunDir: string;
  readonly ownerAccountingFaults: Map<string, OwnerAccountingFault[]>;
  taskAllowance: ChatTaskAllowanceSnapshot | null;
  taskCostScopeUnavailable: boolean;
}

export class ChatEngineOwnerAccounting {
  constructor(private readonly host: ChatEngineOwnerAccountingHost) {}

  /** A task can be retired while its provider still reports a billable result. */
  ownerChargeDir(runDir = this.host.engineRunDir): string {
    return join(runDir, 'task-charges');
  }

  ownerChargePath(ownerId: string, runDir = this.host.engineRunDir): string {
    const name = createHash('sha256').update(ownerId).digest('hex');
    return join(this.ownerChargeDir(runDir), `${name}.json`);
  }

  recordOwnerAccountingFault(
    scope: ChatUsageScope,
    kind: OwnerAccountingFault['kind'],
    reason: string,
    appliesToCurrent: boolean,
  ): void {
    const ownerId = scope.taskOwnerId;
    if (!ownerId) {
      if (appliesToCurrent) this.host.taskCostScopeUnavailable = true;
      return;
    }
    const fault: OwnerAccountingFault = {
      taskOwnerId: ownerId,
      ownerGeneration: scope.ownerGeneration ?? null,
      accountingEpoch: scope.accountingEpoch,
      chargeId: scope.chargeId,
      persistenceScope: 'owner-charge-receipt',
      kind,
      reason,
    };
    const faults = this.host.ownerAccountingFaults.get(ownerId) ?? [];
    if (!faults.some((existing) => JSON.stringify(existing) === JSON.stringify(fault))) {
      faults.push(fault);
      this.host.ownerAccountingFaults.set(ownerId, faults);
    }
    if (appliesToCurrent && ownerId === this.host.taskAllowance?.taskOwnerId) {
      this.host.taskCostScopeUnavailable = true;
    }
    this.persistOwnerAccountingFaultCheckpoint();
  }

  /**
   * Mirror owner-scoped faults into the existing task allowance checkpoint.
   * This is a fallback when an owner receipt write fails, not a new ledger. A
   * retired owner's fault remains visible after restart without blocking the
   * currently admitted successor.
   */
  persistOwnerAccountingFaultCheckpoint(): void {
    if (!this.host.taskAllowance) return;
    const accountingFaults = [...this.host.ownerAccountingFaults.values()].flat();
    if (accountingFaults.length === 0) return;
    this.host.taskAllowance.accountingFaults = accountingFaults;
    try {
      const path = join(this.host.engineRunDir, 'task-budget.json');
      const tmpPath = `${path}.tmp-${randomUUID()}`;
      writeFileSync(tmpPath, JSON.stringify(this.host.taskAllowance), 'utf8');
      renameSync(tmpPath, path);
    } catch {
      // The live owner remains fail-closed. If both established checkpoints
      // are unavailable, a cold process cannot recover an unpersisted fault.
    }
  }

  persistOwnerCharges(ownerId: string, runDir = this.host.engineRunDir): void {
    const summary = globalCostTracker.getTaskSummary(ownerId);
    const chargeIds = globalCostTracker.getTaskChargeIds(ownerId);
    const chargeObservations = globalCostTracker.getTaskChargeObservations(ownerId);
    // An old ID-only snapshot cannot safely be rewritten as a complete
    // receipt ledger. Keep its task budget conservative on this path.
    if (chargeObservations.length !== chargeIds.length) {
      throw new Error('Owner charge receipts are incomplete');
    }
    const dir = this.ownerChargeDir(runDir);
    mkdirSync(dir, { recursive: true });
    const path = this.ownerChargePath(ownerId, runDir);
    const tmpPath = `${path}.tmp-${randomUUID()}`;
    writeFileSync(tmpPath, JSON.stringify({
      schemaVersion: 1,
      taskOwnerId: ownerId,
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      totalCostUSD: summary.totalCostUSD,
      unknownChargeCount: summary.unknownChargeCount ?? 0,
      chargeIds,
      chargeObservations,
      accountingFaults: this.host.ownerAccountingFaults.get(ownerId) ?? [],
    }), 'utf8');
    renameSync(tmpPath, path);
  }

  restoreOwnerCharges(runDir: string): boolean {
    const dir = this.ownerChargeDir(runDir);
    if (!existsSync(dir)) return true;
    try {
      for (const name of readdirSync(dir)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const raw: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        if (raw === null || typeof raw !== 'object') throw new Error('Invalid owner charge file');
        const data = raw as Record<string, unknown>;
        if (data['schemaVersion'] !== 1 ||
            typeof data['taskOwnerId'] !== 'string' ||
            name !== `${createHash('sha256').update(data['taskOwnerId']).digest('hex')}.json` ||
            !Array.isArray(data['chargeIds']) ||
            !Array.isArray(data['chargeObservations']) ||
            typeof data['totalCostUSD'] !== 'number' ||
            typeof data['unknownChargeCount'] !== 'number') {
          throw new Error('Invalid owner charge file');
        }
        const accountingFaults = parseOwnerAccountingFaults(data['accountingFaults'] ?? []);
        if (!accountingFaults || accountingFaults.some((fault) => fault.taskOwnerId !== data['taskOwnerId'])) {
          throw new Error('Invalid owner accounting fault');
        }
        if (accountingFaults.length > 0) {
          this.host.ownerAccountingFaults.set(data['taskOwnerId'], accountingFaults as OwnerAccountingFault[]);
        }
        globalCostTracker.restoreTaskUsage(data['taskOwnerId'], {
          totalCostUSD: data['totalCostUSD'],
          unknownChargeCount: data['unknownChargeCount'],
          chargeIds: data['chargeIds'] as string[],
          chargeObservations: data['chargeObservations'] as ChargeReceipt[],
        });
      }
      return true;
    } catch {
      return false;
    }
  }

}

export function parseOwnerAccountingFaults(value: unknown): OwnerAccountingFault[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((fault) => {
    if (fault === null || typeof fault !== 'object') return true;
    const entry = fault as Record<string, unknown>;
    return typeof entry['taskOwnerId'] !== 'string' ||
      !(entry['ownerGeneration'] === null ||
        (typeof entry['ownerGeneration'] === 'number' && Number.isInteger(entry['ownerGeneration']))) ||
      typeof entry['accountingEpoch'] !== 'string' ||
      !(entry['chargeId'] === null || typeof entry['chargeId'] === 'string') ||
      entry['persistenceScope'] !== 'owner-charge-receipt' ||
      !['settlement-conflict', 'persistence-failure'].includes(String(entry['kind'])) ||
      typeof entry['reason'] !== 'string';
  })) return null;
  return value as OwnerAccountingFault[];
}
