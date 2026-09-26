import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { renameSync, writeFileSync } from 'node:fs';
import { captureCostBaselineUsd, globalCostTracker } from '../services/costTracker.js';
import type { ChatEngineLimits, ChatRunLimiter } from '../config/chatEngineLimits.js';
import { deriveChildAllowance, type ChildBudgetLimiter, type InheritedChildAllowance } from './childBudget.js';
import type { ChatTaskAllowanceSnapshot, ChatAllowanceCostCap, ChatAllowanceGrant } from './chatEngine.js';
import type { TurnRuntimeSnapshot } from './turnRuntime.js';
import type { OwnerAccountingFault, ChatEngineOwnerAccounting } from './chatEngineOwnerAccounting.js';

export interface ChatTaskAllowanceHost {
  readonly engineRunDir: string;
  limits: ChatEngineLimits;
  taskAllowance: ChatTaskAllowanceSnapshot | null;
  taskCostBaselineUsd: number;
  taskCostScopeUnavailable: boolean;
  activeExecutionCheckpointMs: number | null;
  lastTurnRuntime: TurnRuntimeSnapshot | null;
  criticRepairCostCapUsd: number | null;
  postWriteRepairWallCapMs: number | null;
  postWriteRepairRestrict: boolean;
  budgetExceeded: boolean;
  budgetLastChanceDone: boolean;
  terminatingLimiter: ChatRunLimiter | null;
  terminalLimiterReason: string | null;
  readonly ownerAccountingFaults: Map<string, OwnerAccountingFault[]>;
  readonly ownerAccounting: ChatEngineOwnerAccounting;
}

export function allowanceCostCap(costCapUsd: number): ChatAllowanceCostCap {
  return Number.isFinite(costCapUsd)
    ? { kind: 'finite', usd: costCapUsd }
    : { kind: 'unlimited' };
}

export function allowanceCostCapUsd(costCap: ChatAllowanceCostCap): number {
  return costCap.kind === 'finite' ? costCap.usd : Infinity;
}

export class ChatEngineTaskAllowance {
  constructor(private readonly host: ChatTaskAllowanceHost) {}

  checkpointActiveWall(nowMs = Date.now()): void {
    const allowance = this.host.taskAllowance;
    if (!allowance || this.host.activeExecutionCheckpointMs === null) return;
    allowance.consumed.activeWallMs += Math.max(0, nowMs - this.host.activeExecutionCheckpointMs);
    this.host.activeExecutionCheckpointMs = nowMs;
  }

  persistTaskAllowance(): void {
    const allowance = this.host.taskAllowance;
    if (this.host.taskCostScopeUnavailable || !allowance) return;
    try {
      this.checkpointActiveWall();
      allowance.accountingEpoch = globalCostTracker.getAccountingEpoch();
      allowance.consumed.costUsd = this.currentTaskCostUsd();
      allowance.consumed.unknownChargeCount =
        globalCostTracker.getTaskSummary(allowance.taskOwnerId).unknownChargeCount ?? 0;
      allowance.accountedChargeIds = globalCostTracker.getTaskChargeIds(allowance.taskOwnerId);
      allowance.activeExecution = this.host.activeExecutionCheckpointMs !== null;
      allowance.repair = {
        criticRepairCostCapUsd: this.host.criticRepairCostCapUsd,
        postWriteRepairWallCapMs: this.host.postWriteRepairWallCapMs,
        postWriteRepairRestrict: this.host.postWriteRepairRestrict,
      };
      if (this.host.lastTurnRuntime) allowance.lastTurnRuntime = this.host.lastTurnRuntime;
      const ownerFaults = [...this.host.ownerAccountingFaults.values()].flat();
      if (ownerFaults.length > 0) allowance.accountingFaults = ownerFaults;
      else delete allowance.accountingFaults;
      this.host.ownerAccounting.persistOwnerCharges(allowance.taskOwnerId);
      const path = join(this.host.engineRunDir, 'task-budget.json');
      const tmpPath = `${path}.tmp-${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(allowance), 'utf8');
      renameSync(tmpPath, path);
    } catch {
      // A missing durable write removes our authority to continue spending.
      this.host.taskCostScopeUnavailable = true;
    }
  }

  createTaskAllowance(): ChatTaskAllowanceSnapshot {
    return {
      schemaVersion: 2,
      taskOwnerId: randomUUID(),
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      grant: {
        grantId: randomUUID(),
        provenance: 'chat-engine-initial',
        costCap: allowanceCostCap(this.host.limits.maxCostUsd),
        wallCapMs: this.host.limits.maxWallMs,
        turnCap: this.host.limits.maxTurns,
      },
      consumed: { costUsd: 0, unknownChargeCount: 0, activeWallMs: 0, turns: 0 },
      repair: {
        criticRepairCostCapUsd: null,
        postWriteRepairWallCapMs: null,
        postWriteRepairRestrict: false,
      },
      accountedChargeIds: [],
      activeExecution: false,
      taskCostBaselineUsd: captureCostBaselineUsd(),
    };
  }

  startIndependentTaskCostScope(): void {
    this.host.taskCostScopeUnavailable = false;
    this.host.taskAllowance = this.createTaskAllowance();
    this.host.taskCostBaselineUsd = this.host.taskAllowance.taskCostBaselineUsd;
    this.host.activeExecutionCheckpointMs = null;
    this.persistTaskAllowance();
  }

  currentTaskCostUsd(): number {
    const allowance = this.host.taskAllowance;
    return allowance ? globalCostTracker.getTaskSummary(allowance.taskOwnerId).totalCostUSD : 0;
  }

  currentTaskActiveWallMs(nowMs = Date.now()): number {
    const allowance = this.host.taskAllowance;
    if (!allowance) return 0;
    return allowance.consumed.activeWallMs +
      (this.host.activeExecutionCheckpointMs === null
        ? 0
        : Math.max(0, nowMs - this.host.activeExecutionCheckpointMs));
  }

  restorePersistedTaskBudget(persisted: ChatTaskAllowanceSnapshot | null): void {
    for (const fault of persisted?.accountingFaults ?? []) {
      const faults = this.host.ownerAccountingFaults.get(fault.taskOwnerId) ?? [];
      if (!faults.some((existing) => JSON.stringify(existing) === JSON.stringify(fault))) faults.push(fault);
      this.host.ownerAccountingFaults.set(fault.taskOwnerId, faults);
    }
    this.host.taskCostScopeUnavailable = persisted === null || persisted.lastTurnRuntime === undefined ||
      this.host.ownerAccountingFaults.has(persisted.taskOwnerId);
    this.host.activeExecutionCheckpointMs = null;
    if (!persisted) {
      this.host.taskAllowance = null;
      this.host.taskCostBaselineUsd = captureCostBaselineUsd();
      this.host.lastTurnRuntime = null;
      return;
    }
    this.host.taskAllowance = persisted;
    this.host.taskCostBaselineUsd = persisted.taskCostBaselineUsd;
    this.host.lastTurnRuntime = persisted.lastTurnRuntime ?? null;
    this.host.criticRepairCostCapUsd = persisted.repair.criticRepairCostCapUsd;
    this.host.postWriteRepairWallCapMs = persisted.repair.postWriteRepairWallCapMs;
    this.host.postWriteRepairRestrict = persisted.repair.postWriteRepairRestrict;
    globalCostTracker.restoreTaskUsage(persisted.taskOwnerId, {
      totalCostUSD: persisted.consumed.costUsd,
      chargeIds: persisted.accountedChargeIds,
      unknownChargeCount: persisted.consumed.unknownChargeCount ?? 1,
    });
    this.host.limits = {
      ...this.host.limits,
      maxCostUsd: allowanceCostCapUsd(persisted.grant.costCap),
      maxWallMs: persisted.grant.wallCapMs,
      maxTurns: persisted.grant.turnCap,
    };
  }

  getTaskAllowanceSnapshot(): ChatTaskAllowanceSnapshot | null {
    const allowance = this.host.taskAllowance;
    if (!allowance) return null;
    return structuredClone({
      ...allowance,
      consumed: {
        ...allowance.consumed,
        costUsd: this.currentTaskCostUsd(),
        activeWallMs: this.currentTaskActiveWallMs(),
      },
      activeExecution: this.host.activeExecutionCheckpointMs !== null,
    });
  }

  renewAllowance(grant: ChatAllowanceGrant): void {
    const allowance = this.host.taskAllowance;
    if (this.host.taskCostScopeUnavailable || !allowance) {
      throw new Error('Cannot renew allowance without a valid durable task scope');
    }
    if (!grant.grantId || !grant.provenance) {
      throw new Error('Allowance renewal requires grant identity and provenance');
    }
    const currentCostCap = allowanceCostCapUsd(allowance.grant.costCap);
    const doesNotDecrease =
      grant.costCapUsd >= currentCostCap &&
      grant.wallCapMs >= allowance.grant.wallCapMs &&
      grant.turnCap >= allowance.grant.turnCap;
    const increases =
      grant.costCapUsd > currentCostCap ||
      grant.wallCapMs > allowance.grant.wallCapMs ||
      grant.turnCap > allowance.grant.turnCap;
    if (!doesNotDecrease || !increases) {
      throw new Error('Allowance renewal must increase at least one cap without decreasing another');
    }
    allowance.grant = {
      grantId: grant.grantId,
      provenance: grant.provenance,
      costCap: allowanceCostCap(grant.costCapUsd),
      wallCapMs: grant.wallCapMs,
      turnCap: grant.turnCap,
    };
    this.host.limits.maxCostUsd = grant.costCapUsd;
    this.host.limits.maxWallMs = grant.wallCapMs;
    this.host.limits.maxTurns = grant.turnCap;
    this.persistTaskAllowance();
  }

  beginActiveExecution(): void {
    if (this.host.activeExecutionCheckpointMs !== null) return;
    this.host.activeExecutionCheckpointMs = Date.now();
    this.persistTaskAllowance();
  }

  pauseActiveExecution(): void {
    if (this.host.activeExecutionCheckpointMs === null) return;
    this.checkpointActiveWall();
    this.host.activeExecutionCheckpointMs = null;
    this.persistTaskAllowance();
  }

  settleActiveExecutionForTerminal(): void {
    this.pauseActiveExecution();
  }

  consumeTaskTurn(): void {
    const allowance = this.host.taskAllowance;
    if (!allowance) return;
    allowance.consumed.turns += 1;
    this.persistTaskAllowance();
  }

  effectiveCostCapUsd(): number {
    return this.host.criticRepairCostCapUsd == null
      ? this.host.limits.maxCostUsd
      : Math.min(this.host.limits.maxCostUsd, this.host.criticRepairCostCapUsd);
  }

  effectiveWallCapMs(): number {
    return this.host.postWriteRepairWallCapMs == null
      ? this.host.limits.maxWallMs
      : Math.min(this.host.limits.maxWallMs, this.host.postWriteRepairWallCapMs);
  }

  deriveChildAllowance(maxRounds: number): InheritedChildAllowance {
    const allowance = this.host.taskAllowance;
    if (!allowance) throw new Error('Cannot delegate without a durable task allowance');
    const parentDeadlineAtMs =
      Date.now() + Math.max(0, this.effectiveWallCapMs() - this.currentTaskActiveWallMs());
    return deriveChildAllowance({
      parentTaskOwnerId: allowance.taskOwnerId,
      parentTaskBaselineUsd: this.host.taskCostBaselineUsd,
      parentEffectiveCostCapUsd: this.effectiveCostCapUsd(),
      parentDeadlineAtMs,
      childMaxRounds: maxRounds,
    });
  }

  markChildBudgetExhausted(limiter: ChildBudgetLimiter, reason: string): void {
    this.host.budgetExceeded = true;
    this.host.budgetLastChanceDone = true;
    this.host.terminatingLimiter = 'child_exhaustion';
    this.host.terminalLimiterReason = `Inherited child ${limiter} allowance exhausted: ${reason}`;
  }
}
