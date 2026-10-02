import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { renameSync, writeFileSync } from "node:fs";
import {
  captureCostBaselineUsd,
  globalCostTracker,
} from "../services/costTracker.js";
import type {
  ChatEngineLimits,
  ChatRunLimiter,
} from "../config/chatEngineLimits.js";
import {
  deriveChildAllowance,
  type ChildBudgetLimiter,
  type InheritedChildAllowance,
} from "./childBudget.js";
import type {
  ChatTaskAllowanceSnapshot,
  ChatAllowanceCostCap,
  ChatAllowanceGrant,
} from "./chatEngineContracts.js";
import type { TurnRuntimeSnapshot } from "./turnRuntime.js";
import {
  parseOwnerAccountingFaults,
  type OwnerAccountingFault,
  type ChatEngineOwnerAccounting,
} from "./chatEngineOwnerAccounting.js";

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
    ? { kind: "finite", usd: costCapUsd }
    : { kind: "unlimited" };
}

export function allowanceCostCapUsd(costCap: ChatAllowanceCostCap): number {
  return costCap.kind === "finite" ? costCap.usd : Infinity;
}

export class ChatEngineTaskAllowance {
  constructor(private readonly host: ChatTaskAllowanceHost) {}

  checkpointActiveWall(nowMs = Date.now()): void {
    const allowance = this.host.taskAllowance;
    if (!allowance || this.host.activeExecutionCheckpointMs === null) return;
    allowance.consumed.activeWallMs += Math.max(
      0,
      nowMs - this.host.activeExecutionCheckpointMs,
    );
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
        globalCostTracker.getTaskSummary(allowance.taskOwnerId)
          .unknownChargeCount ?? 0;
      allowance.accountedChargeIds = globalCostTracker.getTaskChargeIds(
        allowance.taskOwnerId,
      );
      allowance.activeExecution =
        this.host.activeExecutionCheckpointMs !== null;
      allowance.repair = {
        criticRepairCostCapUsd: this.host.criticRepairCostCapUsd,
        postWriteRepairWallCapMs: this.host.postWriteRepairWallCapMs,
        postWriteRepairRestrict: this.host.postWriteRepairRestrict,
      };
      if (this.host.lastTurnRuntime)
        allowance.lastTurnRuntime = this.host.lastTurnRuntime;
      const ownerFaults = [...this.host.ownerAccountingFaults.values()].flat();
      if (ownerFaults.length > 0) allowance.accountingFaults = ownerFaults;
      else delete allowance.accountingFaults;
      this.host.ownerAccounting.persistOwnerCharges(allowance.taskOwnerId);
      const path = join(this.host.engineRunDir, "task-budget.json");
      const tmpPath = `${path}.tmp-${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(allowance), "utf8");
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
        provenance: "chat-engine-initial",
        costCap: allowanceCostCap(this.host.limits.maxCostUsd),
        wallCapMs: this.host.limits.maxWallMs,
        turnCap: this.host.limits.maxTurns,
      },
      consumed: {
        costUsd: 0,
        unknownChargeCount: 0,
        activeWallMs: 0,
        turns: 0,
      },
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
    return allowance
      ? globalCostTracker.getTaskSummary(allowance.taskOwnerId).totalCostUSD
      : 0;
  }

  currentTaskActiveWallMs(nowMs = Date.now()): number {
    const allowance = this.host.taskAllowance;
    if (!allowance) return 0;
    return (
      allowance.consumed.activeWallMs +
      (this.host.activeExecutionCheckpointMs === null
        ? 0
        : Math.max(0, nowMs - this.host.activeExecutionCheckpointMs))
    );
  }

  restorePersistedTaskBudget(
    persisted: ChatTaskAllowanceSnapshot | null,
  ): void {
    for (const fault of persisted?.accountingFaults ?? []) {
      const faults =
        this.host.ownerAccountingFaults.get(fault.taskOwnerId) ?? [];
      if (
        !faults.some(
          (existing) => JSON.stringify(existing) === JSON.stringify(fault),
        )
      )
        faults.push(fault);
      this.host.ownerAccountingFaults.set(fault.taskOwnerId, faults);
    }
    this.host.taskCostScopeUnavailable =
      persisted === null ||
      persisted.lastTurnRuntime === undefined ||
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
    this.host.postWriteRepairWallCapMs =
      persisted.repair.postWriteRepairWallCapMs;
    this.host.postWriteRepairRestrict =
      persisted.repair.postWriteRepairRestrict;
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
      throw new Error(
        "Cannot renew allowance without a valid durable task scope",
      );
    }
    if (!grant.grantId || !grant.provenance) {
      throw new Error(
        "Allowance renewal requires grant identity and provenance",
      );
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
      throw new Error(
        "Allowance renewal must increase at least one cap without decreasing another",
      );
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
      : Math.min(
          this.host.limits.maxWallMs,
          this.host.postWriteRepairWallCapMs,
        );
  }

  deriveChildAllowance(maxRounds: number): InheritedChildAllowance {
    const allowance = this.host.taskAllowance;
    if (!allowance)
      throw new Error("Cannot delegate without a durable task allowance");
    const parentDeadlineAtMs =
      Date.now() +
      Math.max(0, this.effectiveWallCapMs() - this.currentTaskActiveWallMs());
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
    this.host.terminatingLimiter = "child_exhaustion";
    this.host.terminalLimiterReason = `Inherited child ${limiter} allowance exhausted: ${reason}`;
  }
}

/** Validate the durable allowance checkpoint without restoring a crashed active marker. */
function isPersistedTurnRuntime(value: unknown): value is TurnRuntimeSnapshot {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const numericKeys = [
    "submissionIndex",
    "writeCount",
    "gateStrikes",
    "criticStrikes",
    "turnsWithoutWrite",
    "consecutiveReadOnlyTools",
    "consecutiveNonMutatingShells",
    "toolsWithoutWrite",
  ];
  if (
    numericKeys.some(
      (key) =>
        typeof candidate[key] !== "number" || !Number.isFinite(candidate[key]),
    )
  ) {
    return false;
  }
  const booleanKeys = [
    "midLoopCriticFired",
    "budgetExceeded",
    "budgetLastChanceDone",
    "restrictToolsNextTurn",
    "continuedTask",
  ];
  if (booleanKeys.some((key) => typeof candidate[key] !== "boolean"))
    return false;
  if (
    typeof candidate.taskText !== "string" ||
    (candidate.taskIntent !== "execute" &&
      candidate.taskIntent !== "explain") ||
    typeof candidate.taskClass !== "string" ||
    typeof candidate.projectRoot !== "string" ||
    (candidate.stickyIntent !== null &&
      candidate.stickyIntent !== "execute" &&
      candidate.stickyIntent !== "explain") ||
    (candidate.gatePolicy !== null &&
      candidate.gatePolicy !== "none" &&
      candidate.gatePolicy !== "required" &&
      candidate.gatePolicy !== "strict")
  ) {
    return false;
  }
  return true;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseTaskAllowance(
  value: unknown,
): ChatTaskAllowanceSnapshot | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate["schemaVersion"] !== 2) return null;
  if (
    typeof candidate["taskOwnerId"] !== "string" ||
    candidate["taskOwnerId"].length === 0 ||
    typeof candidate["accountingEpoch"] !== "string"
  )
    return null;
  const grant = candidate["grant"];
  const consumed = candidate["consumed"];
  const repair = candidate["repair"];
  if (
    grant === null ||
    typeof grant !== "object" ||
    consumed === null ||
    typeof consumed !== "object" ||
    repair === null ||
    typeof repair !== "object"
  )
    return null;
  const grantRecord = grant as Record<string, unknown>;
  const consumedRecord = consumed as Record<string, unknown>;
  const repairRecord = repair as Record<string, unknown>;
  const rawCostCap = grantRecord["costCap"];
  if (rawCostCap === null || typeof rawCostCap !== "object") return null;
  const costCapRecord = rawCostCap as Record<string, unknown>;
  const costCap: ChatAllowanceCostCap | null =
    costCapRecord["kind"] === "unlimited"
      ? { kind: "unlimited" }
      : costCapRecord["kind"] === "finite" &&
          isNonNegativeFinite(costCapRecord["usd"])
        ? { kind: "finite", usd: costCapRecord["usd"] }
        : null;
  if (
    costCap === null ||
    typeof grantRecord["grantId"] !== "string" ||
    grantRecord["grantId"].length === 0 ||
    typeof grantRecord["provenance"] !== "string" ||
    grantRecord["provenance"].length === 0 ||
    !isNonNegativeFinite(grantRecord["wallCapMs"]) ||
    !Number.isInteger(grantRecord["turnCap"]) ||
    (grantRecord["turnCap"] as number) < 1 ||
    !isNonNegativeFinite(consumedRecord["costUsd"]) ||
    !isNonNegativeFinite(consumedRecord["activeWallMs"]) ||
    !Number.isInteger(consumedRecord["turns"]) ||
    (consumedRecord["turns"] as number) < 0 ||
    (repairRecord["criticRepairCostCapUsd"] !== null &&
      !isNonNegativeFinite(repairRecord["criticRepairCostCapUsd"])) ||
    (repairRecord["postWriteRepairWallCapMs"] !== null &&
      !isNonNegativeFinite(repairRecord["postWriteRepairWallCapMs"])) ||
    typeof repairRecord["postWriteRepairRestrict"] !== "boolean" ||
    !Array.isArray(candidate["accountedChargeIds"]) ||
    !(candidate["accountedChargeIds"] as unknown[]).every(
      (id) => typeof id === "string",
    ) ||
    typeof candidate["activeExecution"] !== "boolean" ||
    !isNonNegativeFinite(candidate["taskCostBaselineUsd"])
  )
    return null;
  const accountingFaults =
    candidate["accountingFaults"] === undefined
      ? []
      : parseOwnerAccountingFaults(candidate["accountingFaults"]);
  if (accountingFaults === null) return null;
  const parsed: ChatTaskAllowanceSnapshot = {
    schemaVersion: 2,
    taskOwnerId: candidate["taskOwnerId"],
    accountingEpoch: candidate["accountingEpoch"],
    grant: {
      grantId: grantRecord["grantId"],
      provenance: grantRecord["provenance"],
      costCap,
      wallCapMs: grantRecord["wallCapMs"],
      turnCap: grantRecord["turnCap"] as number,
    },
    consumed: {
      costUsd: consumedRecord["costUsd"],
      unknownChargeCount: isNonNegativeFinite(
        consumedRecord["unknownChargeCount"],
      )
        ? consumedRecord["unknownChargeCount"]
        : 1,
      activeWallMs: consumedRecord["activeWallMs"],
      turns: consumedRecord["turns"] as number,
    },
    repair: {
      criticRepairCostCapUsd: repairRecord["criticRepairCostCapUsd"] as
        | number
        | null,
      postWriteRepairWallCapMs: repairRecord["postWriteRepairWallCapMs"] as
        | number
        | null,
      postWriteRepairRestrict: repairRecord["postWriteRepairRestrict"],
    },
    accountedChargeIds: [...(candidate["accountedChargeIds"] as string[])],
    // A crashed active marker is cleared on restore; downtime is not execution.
    activeExecution: false,
    taskCostBaselineUsd: candidate["taskCostBaselineUsd"],
    ...(accountingFaults.length > 0 ? { accountingFaults } : {}),
    ...(isPersistedTurnRuntime(candidate["lastTurnRuntime"])
      ? { lastTurnRuntime: candidate["lastTurnRuntime"] }
      : {}),
  };
  return parsed;
}
