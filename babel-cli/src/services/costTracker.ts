import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  estimateProviderUsageCost,
  getModelPricingByModelId,
} from './modelPricingRegistry.js';
import { getGlobalTokenHistoryDb } from './tokenHistoryDb.js';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  /** Known subtotal; a nonzero unknown count makes the full cost unavailable. */
  unknownChargeCount?: number;
  completeCostUSD?: number | null;
  /** P-3.1: DeepSeek context cache hit tokens (KV cache reuse across turns). */
  promptCacheHitTokens?: number;
  /** P-3.1: DeepSeek context cache miss tokens (new encoding required). */
  promptCacheMissTokens?: number;
}

export interface ProjectStats {
  totalCostUSD: number;
  completeCostUSD?: number | null;
  unknownChargeCount?: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastSessionId?: string;
  modelBreakdown: Record<string, ModelUsage>;
  sessionSnapshots?: Record<string, SessionUsageSummary>;
  /** A legacy aggregate cannot be disaggregated into idempotent session receipts. */
  projectionComplete?: boolean;
}

/** This-turn billed usage from two session snapshots. Never negative. */
export function usageDelta(
  before: Pick<SessionUsageSummary, 'totalCostUSD' | 'totalTokens'>,
  after: Pick<SessionUsageSummary, 'totalCostUSD' | 'totalTokens'>,
): { costUsd: number; tokens: number } {
  return {
    costUsd: Math.max(0, after.totalCostUSD - before.totalCostUSD),
    tokens: Math.max(0, after.totalTokens - before.totalTokens),
  };
}

/** Capture the current global total as the start of an independent task. */
export function captureCostBaselineUsd(): number {
  return globalCostTracker.getSessionSummary().totalCostUSD;
}

/**
 * Return spend attributable to a task that started at `baselineUsd`.
 * Global tracker totals remain the accounting truth; this delta is the
 * enforcement truth for one task/run and is never negative after restore.
 */
export function costSpentSinceBaselineUsd(baselineUsd: number): number {
  return Math.max(
    0,
    globalCostTracker.getSessionSummary().totalCostUSD - baselineUsd,
  );
}

export interface SessionUsageSummary {
  totalCostUSD: number;
  /** Full cost remains null while any provider charge lacks a known price. */
  completeCostUSD?: number | null;
  knownCostUSD?: number;
  unknownChargeCount?: number;
  costComplete?: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  /** P-3.1: Total prompt cache hit tokens across all models. */
  totalCacheHitTokens?: number;
  /** P-3.1: Total prompt cache miss tokens across all models. */
  totalCacheMissTokens?: number;
  modelBreakdown: Record<string, ModelUsage>;
}

/** Stable task attribution for one provider-billed usage charge. */
export interface UsageAttribution {
  /** Immutable owner of the task that initiated this provider boundary. */
  taskOwnerId: string;
  /** Stable provider request/attempt identity used for idempotent replay. */
  chargeId: string;
  /** Optional delegating task. Child usage is charged to this owner once. */
  parentTaskOwnerId?: string;
  accountingEpoch?: string;
  turnId?: string;
  requestId?: string;
  attemptId?: string;
}

/** Accepted settlement delta, or a replay/conflict with no projection. */
export type ChargeUpdate =
  | { kind: 'inserted' | 'refined'; knownCostDelta: number; unknownDelta: number }
  | { kind: 'duplicate' }
  | { kind: 'conflict'; reason: string };

/** Durable observation of one provider attempt, scoped to its immutable owner. */
export interface ChargeReceipt {
  attribution: UsageAttribution;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  knownCostUSD: number | null;
}

interface ChargeObservation extends ChargeReceipt {
  projectedInSession: boolean;
  restoredInSession?: boolean;
}

export class CostTracker {
  private readonly accountingEpoch = randomUUID();
  private projectSessionId: string = randomUUID();
  private sessionUsage: Record<string, ModelUsage> = {};
  private sessionTotalCost = 0;
  private sessionUnknownCharges = 0;
  private taskUsage = new Map<string, Record<string, ModelUsage>>();
  private taskTotalCost = new Map<string, number>();
  private taskUnknownCharges = new Map<string, number>();
  private taskChargeIds = new Map<string, Set<string>>();
  private recordedChargeIds = new Set<string>();
  private chargeObservations = new Map<string, ChargeObservation>();
  private restoredSessionChargeIds: Set<string> | null = null;
  private restoredSessionObservations: Map<string, ChargeReceipt> | null = null;
  private sessionProjectionComplete = true;
  /** Restored receipts can outrun project files without carrying a project root. */
  private restoredProjectAttributionIncomplete = false;
  private projectStatsPath: string;

  constructor(projectRoot?: string) {
    this.projectStatsPath = projectRoot
      ? join(projectRoot, 'project_stats.json')
      : join(process.cwd(), 'project_stats.json');
  }

  public trackUsage(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cacheHitTokens?: number | null,
    cacheMissTokens?: number | null,
    attribution?: UsageAttribution,
    usageKnown = true,
  ): number | null {
    const update = this.settleUsage(modelId, inputTokens, outputTokens, cacheHitTokens,
      cacheMissTokens, attribution, usageKnown);
    if (update.kind === 'duplicate' || update.kind === 'conflict') return 0;
    return update.unknownDelta > 0 ? null : update.knownCostDelta;
  }

  /** Settle one attempt without projecting duplicate or conflicting telemetry. */
  public settleUsage(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cacheHitTokens?: number | null,
    cacheMissTokens?: number | null,
    attribution?: UsageAttribution,
    usageKnown = true,
  ): ChargeUpdate {
    if (attribution?.accountingEpoch && attribution.accountingEpoch !== this.accountingEpoch) {
      throw new Error('Usage attribution belongs to a different accounting epoch');
    }
    if ([inputTokens, outputTokens, cacheHitTokens ?? 0, cacheMissTokens ?? 0]
      .some((value) => !Number.isSafeInteger(value) || value < 0)) {
      return { kind: 'conflict', reason: 'Invalid provider token usage' };
    }
    const pricingEntry = getModelPricingByModelId(modelId);
    const estimate = estimateProviderUsageCost({
      provider: pricingEntry?.provider ?? null,
      modelId,
      promptTokens: inputTokens,
      completionTokens: outputTokens,
    });
    const cost = usageKnown ? estimate.estimatedCostUsd : null;
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) {
      return { kind: 'conflict', reason: 'Invalid provider cost estimate' };
    }
    const previous = attribution ? this.chargeObservations.get(attribution.chargeId) : undefined;
    if (attribution && this.recordedChargeIds.has(attribution.chargeId) && !previous) {
      return { kind: 'duplicate' }; // Restored legacy receipt lacks refinement evidence.
    }
    if (previous) {
      const sameIdentity = previous.modelId === modelId &&
        (['taskOwnerId', 'parentTaskOwnerId', 'accountingEpoch', 'turnId', 'requestId', 'attemptId'] as const)
          .every((key) => previous.attribution[key] === attribution?.[key]);
      if (!sameIdentity) return { kind: 'conflict', reason: 'Charge identity differs from the recorded attempt' };
      if (previous.knownCostUSD !== null) {
        if (cost === null) return { kind: 'duplicate' }; // A stale unknown cannot downgrade a known receipt.
        return previous.knownCostUSD === cost && previous.inputTokens === inputTokens &&
          previous.outputTokens === outputTokens && previous.cacheHitTokens === (cacheHitTokens ?? 0) &&
          previous.cacheMissTokens === (cacheMissTokens ?? 0)
          ? { kind: 'duplicate' }
          : { kind: 'conflict', reason: 'Confirmed charge telemetry changed' };
      }
      if (cost === null) {
        if (inputTokens === previous.inputTokens && outputTokens === previous.outputTokens &&
            (cacheHitTokens ?? 0) === previous.cacheHitTokens &&
            (cacheMissTokens ?? 0) === previous.cacheMissTokens) return { kind: 'duplicate' };
        if (inputTokens < previous.inputTokens || outputTokens < previous.outputTokens ||
            (cacheHitTokens ?? 0) < previous.cacheHitTokens ||
            (cacheMissTokens ?? 0) < previous.cacheMissTokens) {
          return { kind: 'conflict', reason: 'Unresolved charge telemetry regressed' };
        }
      }
      if (inputTokens < previous.inputTokens || outputTokens < previous.outputTokens ||
          (cacheHitTokens ?? 0) < previous.cacheHitTokens ||
          (cacheMissTokens ?? 0) < previous.cacheMissTokens) {
        return { kind: 'conflict', reason: 'Refinement lost previously observed tokens' };
      }
    }
    const knownCostDelta = cost ?? 0;
    const unknownDelta = cost === null ? previous ? 0 : 1 : previous ? -1 : 0;
    const inputDelta = inputTokens - (previous?.inputTokens ?? 0);
    const outputDelta = outputTokens - (previous?.outputTokens ?? 0);
    const cacheHitDelta = (cacheHitTokens ?? 0) - (previous?.cacheHitTokens ?? 0);
    const cacheMissDelta = (cacheMissTokens ?? 0) - (previous?.cacheMissTokens ?? 0);
    if (!this.sessionUsage[modelId]) {
      this.sessionUsage[modelId] = { inputTokens: 0, outputTokens: 0, costUSD: 0 };
    }
    const model = this.sessionUsage[modelId];
    // A cold-restored owner was not necessarily included in this process's
    // session projection. Do not subtract its unknown count or replay tokens.
    const priorSessionProjected = previous?.projectedInSession ?? true;
    if (previous?.restoredInSession) {
      const restored = this.sessionUsage['__restored__'];
      if (!restored) return { kind: 'conflict', reason: 'Restored session projection is missing' };
      restored.inputTokens -= previous.inputTokens;
      restored.outputTokens -= previous.outputTokens;
      restored.promptCacheHitTokens = (restored.promptCacheHitTokens ?? 0) - previous.cacheHitTokens;
      restored.promptCacheMissTokens = (restored.promptCacheMissTokens ?? 0) - previous.cacheMissTokens;
      restored.unknownChargeCount = (restored.unknownChargeCount ?? 0) - 1;
      restored.completeCostUSD = restored.unknownChargeCount === 0 ? restored.costUSD : null;
    }
    model.inputTokens += previous?.restoredInSession ? inputTokens : priorSessionProjected ? inputDelta : inputTokens;
    model.outputTokens += previous?.restoredInSession ? outputTokens : priorSessionProjected ? outputDelta : outputTokens;
    model.costUSD += knownCostDelta;
    const sessionUnknownDelta = priorSessionProjected ? unknownDelta : cost === null ? 1 : 0;
    model.unknownChargeCount = (model.unknownChargeCount ?? 0) +
      (previous?.restoredInSession ? cost === null ? 1 : 0 : sessionUnknownDelta);
    model.completeCostUSD = model.unknownChargeCount === 0 ? model.costUSD : null;
    model.promptCacheHitTokens = (model.promptCacheHitTokens ?? 0) +
      (previous?.restoredInSession ? (cacheHitTokens ?? 0) : priorSessionProjected ? cacheHitDelta : (cacheHitTokens ?? 0));
    model.promptCacheMissTokens = (model.promptCacheMissTokens ?? 0) +
      (previous?.restoredInSession ? (cacheMissTokens ?? 0) : priorSessionProjected ? cacheMissDelta : (cacheMissTokens ?? 0));
    this.sessionTotalCost += knownCostDelta;
    this.sessionUnknownCharges += sessionUnknownDelta;
    if (attribution) {
      this.recordedChargeIds.add(attribution.chargeId);
      this.chargeObservations.set(attribution.chargeId, {
        attribution: { ...attribution }, modelId, inputTokens, outputTokens,
        cacheHitTokens: cacheHitTokens ?? 0, cacheMissTokens: cacheMissTokens ?? 0,
        knownCostUSD: cost, projectedInSession: true,
      });
      const owners = new Set([
        attribution.taskOwnerId,
        ...(attribution.parentTaskOwnerId ? [attribution.parentTaskOwnerId] : []),
      ]);
      for (const ownerId of owners) {
        this.recordTaskUsage(
          ownerId,
          attribution.chargeId,
          modelId,
          inputDelta,
          outputDelta,
          knownCostDelta,
          unknownDelta,
          cacheHitDelta,
          cacheMissDelta,
        );
      }
    }
    return { kind: previous ? 'refined' : 'inserted', knownCostDelta, unknownDelta };
  }

  /** A paid request with missing usage cannot be priced as a zero-token call. */
  public recordUnknownCharge(modelId: string, attribution?: UsageAttribution): void {
    this.trackUsage(modelId, 0, 0, null, null, attribution, false);
  }

  /** Retract only a zero-token pending attempt proven to have stopped before inference. */
  public clearUnstartedCharge(attribution: UsageAttribution): boolean {
    const prior = this.chargeObservations.get(attribution.chargeId);
    if (!prior || prior.knownCostUSD !== null || prior.inputTokens !== 0 ||
        prior.outputTokens !== 0 || prior.cacheHitTokens !== 0 || prior.cacheMissTokens !== 0 ||
        JSON.stringify(prior.attribution) !== JSON.stringify(attribution)) return false;
    if (prior.projectedInSession) {
      const model = this.sessionUsage[prior.modelId];
      if (prior.restoredInSession) {
        if (this.sessionUsage['__restored__']) {
          this.sessionUsage['__restored__'].unknownChargeCount =
            (this.sessionUsage['__restored__'].unknownChargeCount ?? 0) - 1;
          const restored = this.sessionUsage['__restored__'];
          restored.completeCostUSD = restored.unknownChargeCount === 0 ? restored.costUSD : null;
        }
      } else if (model) {
        model.unknownChargeCount = (model.unknownChargeCount ?? 0) - 1;
        model.completeCostUSD = model.unknownChargeCount === 0 ? model.costUSD : null;
      }
      this.sessionUnknownCharges--;
    }
    for (const owner of new Set([attribution.taskOwnerId,
      ...(attribution.parentTaskOwnerId ? [attribution.parentTaskOwnerId] : [])])) {
      const model = this.taskUsage.get(owner)?.[prior.modelId];
      if (model) {
        model.unknownChargeCount = (model.unknownChargeCount ?? 0) - 1;
        model.completeCostUSD = model.unknownChargeCount === 0 ? model.costUSD : null;
      }
      this.taskUnknownCharges.set(owner, (this.taskUnknownCharges.get(owner) ?? 0) - 1);
      this.taskChargeIds.get(owner)?.delete(attribution.chargeId);
    }
    this.chargeObservations.delete(attribution.chargeId);
    this.recordedChargeIds.delete(attribution.chargeId);
    this.restoredSessionChargeIds?.delete(attribution.chargeId);
    this.restoredSessionObservations?.delete(attribution.chargeId);
    return true;
  }

  private recordTaskUsage(
    taskOwnerId: string,
    chargeId: string,
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    costUSD: number,
    unknownDelta: number,
    cacheHitTokens: number,
    cacheMissTokens: number,
  ): void {
    const usage = this.taskUsage.get(taskOwnerId) ?? {};
    const model = usage[modelId] ?? { inputTokens: 0, outputTokens: 0, costUSD: 0 };
    model.inputTokens += inputTokens;
    model.outputTokens += outputTokens;
    model.costUSD += costUSD;
    model.unknownChargeCount = (model.unknownChargeCount ?? 0) + unknownDelta;
    model.completeCostUSD = model.unknownChargeCount === 0 ? model.costUSD : null;
    this.taskUnknownCharges.set(taskOwnerId, (this.taskUnknownCharges.get(taskOwnerId) ?? 0) + unknownDelta);
    this.taskTotalCost.set(taskOwnerId, (this.taskTotalCost.get(taskOwnerId) ?? 0) + costUSD);
    model.promptCacheHitTokens = (model.promptCacheHitTokens ?? 0) + cacheHitTokens;
    model.promptCacheMissTokens = (model.promptCacheMissTokens ?? 0) + cacheMissTokens;
    usage[modelId] = model;
    this.taskUsage.set(taskOwnerId, usage);
    const charges = this.taskChargeIds.get(taskOwnerId) ?? new Set<string>();
    charges.add(chargeId);
    this.taskChargeIds.set(taskOwnerId, charges);
  }

  public resetSession(): void {
    this.projectSessionId = randomUUID();
    this.sessionUsage = {};
    this.sessionTotalCost = 0;
    this.sessionUnknownCharges = 0;
    this.taskUsage.clear();
    this.taskTotalCost.clear();
    this.taskUnknownCharges.clear();
    this.taskChargeIds.clear();
    this.recordedChargeIds.clear();
    this.chargeObservations.clear();
    this.restoredSessionChargeIds = null;
    this.restoredSessionObservations = null;
    this.sessionProjectionComplete = true;
    this.restoredProjectAttributionIncomplete = false;
  }

  /** Identifies the in-process accounting epoch for durable task scoping. */
  public getAccountingEpoch(): string {
    return this.accountingEpoch;
  }

  public getProjectSessionId(): string {
    return this.projectSessionId;
  }

  /** Restore cost state from a saved session (resume). */
  public restoreSessionCost(totals: {
    totalCostUSD: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    unknownChargeCount?: number;
    accountedChargeIds?: string[];
    chargeObservations?: ChargeReceipt[];
    projectSessionId?: string;
  }): void {
    // A persisted snapshot cannot supersede receipts already seen in this process.
    if (Object.keys(this.sessionUsage).length > 0 || this.sessionTotalCost !== 0 ||
        this.sessionUnknownCharges !== 0) return;
    this.sessionTotalCost = totals.totalCostUSD;
    if (typeof totals.projectSessionId === 'string' && totals.projectSessionId.length > 0) {
      this.projectSessionId = totals.projectSessionId;
    }
    this.sessionUnknownCharges = totals.unknownChargeCount ?? 0;
    const chargeIds = totals.accountedChargeIds;
    this.restoredSessionChargeIds = Array.isArray(chargeIds) &&
      chargeIds.every((id) => typeof id === 'string' && id.length > 0) &&
      new Set(chargeIds).size === chargeIds.length
      ? new Set(chargeIds) : null;
    const observations = totals.chargeObservations;
    this.restoredSessionObservations = this.restoredSessionChargeIds && Array.isArray(observations) &&
      observations.length === this.restoredSessionChargeIds.size &&
      observations.every((receipt) => receipt?.attribution &&
        this.restoredSessionChargeIds!.has(receipt.attribution.chargeId) &&
        typeof receipt.modelId === 'string' && receipt.modelId.length > 0 &&
        [receipt.inputTokens, receipt.outputTokens, receipt.cacheHitTokens, receipt.cacheMissTokens]
          .every((value) => Number.isSafeInteger(value) && value >= 0) &&
        (receipt.knownCostUSD === null ||
          (typeof receipt.knownCostUSD === 'number' && Number.isFinite(receipt.knownCostUSD) &&
           receipt.knownCostUSD >= 0))) &&
      new Set(observations.map((receipt) => receipt.attribution.chargeId)).size === observations.length
      ? new Map(observations.map((receipt) => [receipt.attribution.chargeId, receipt])) : null;
    this.sessionProjectionComplete = this.restoredSessionObservations !== null;
    // Best-effort: reconstruct a synthetic usage entry so getSessionSummary() returns non-zero
    if (totals.totalTokens > 0 || totals.totalCostUSD > 0 || this.sessionUnknownCharges > 0) {
      this.sessionUsage['__restored__'] = {
        inputTokens: totals.totalInputTokens,
        outputTokens: totals.totalOutputTokens,
        costUSD: totals.totalCostUSD,
        unknownChargeCount: this.sessionUnknownCharges,
        completeCostUSD: this.sessionUnknownCharges === 0 ? totals.totalCostUSD : null,
        // Cache fields set to 0 since they can't be recovered from a previous session
        // but the structure must be consistent with ModelUsage.
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 0,
      };
    }
  }

  public getSessionSummary(): SessionUsageSummary {
    const modelBreakdown = Object.fromEntries(
      Object.entries(this.sessionUsage).map(([modelId, usage]) => [modelId, { ...usage }]),
    );
    const totalInputTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + usage.inputTokens,
      0,
    );
    const totalOutputTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + usage.outputTokens,
      0,
    );

    const totalCacheHitTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + (usage.promptCacheHitTokens ?? 0),
      0,
    );
    const totalCacheMissTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + (usage.promptCacheMissTokens ?? 0),
      0,
    );

    const summary: SessionUsageSummary = {
      totalCostUSD: this.sessionTotalCost,
      knownCostUSD: this.sessionTotalCost,
      completeCostUSD: this.sessionUnknownCharges === 0 && this.sessionProjectionComplete ? this.sessionTotalCost : null,
      unknownChargeCount: this.sessionUnknownCharges,
      costComplete: this.sessionUnknownCharges === 0 && this.sessionProjectionComplete,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      modelBreakdown,
    };
    if (totalCacheHitTokens > 0) {
      summary.totalCacheHitTokens = totalCacheHitTokens;
    }
    if (totalCacheMissTokens > 0) {
      summary.totalCacheMissTokens = totalCacheMissTokens;
    }
    return summary;
  }

  /** Return usage attributed to one immutable task owner. */
  public getTaskSummary(taskOwnerId: string): SessionUsageSummary {
    const modelBreakdown = Object.fromEntries(
      Object.entries(this.taskUsage.get(taskOwnerId) ?? {}).map(([modelId, usage]) => [
        modelId,
        { ...usage },
      ]),
    );
    const totalInputTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + usage.inputTokens,
      0,
    );
    const totalOutputTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + usage.outputTokens,
      0,
    );
    const totalCacheHitTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + (usage.promptCacheHitTokens ?? 0),
      0,
    );
    const totalCacheMissTokens = Object.values(modelBreakdown).reduce(
      (sum, usage) => sum + (usage.promptCacheMissTokens ?? 0),
      0,
    );
    return {
      totalCostUSD: this.taskTotalCost.get(taskOwnerId) ?? 0,
      knownCostUSD: this.taskTotalCost.get(taskOwnerId) ?? 0,
      completeCostUSD: (this.taskUnknownCharges.get(taskOwnerId) ?? 0) === 0
        ? (this.taskTotalCost.get(taskOwnerId) ?? 0) : null,
      unknownChargeCount: this.taskUnknownCharges.get(taskOwnerId) ?? 0,
      costComplete: (this.taskUnknownCharges.get(taskOwnerId) ?? 0) === 0,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      modelBreakdown,
      ...(totalCacheHitTokens > 0 ? { totalCacheHitTokens } : {}),
      ...(totalCacheMissTokens > 0 ? { totalCacheMissTokens } : {}),
    };
  }

  /** Stable charge identities already applied to one task owner. */
  public getTaskChargeIds(taskOwnerId: string): string[] {
    return [...(this.taskChargeIds.get(taskOwnerId) ?? new Set<string>())];
  }

  public getSessionChargeIds(): string[] {
    return [...new Set([
      ...(this.restoredSessionChargeIds ?? []),
      ...[...this.chargeObservations.values()]
        .filter((receipt) => receipt.projectedInSession)
        .map((receipt) => receipt.attribution.chargeId),
    ])];
  }

  public getSessionChargeObservations(): ChargeReceipt[] {
    const observations = new Map(this.restoredSessionObservations ?? []);
    for (const receipt of this.chargeObservations.values()) {
      if (receipt.projectedInSession) {
        const { projectedInSession: _projectedInSession, restoredInSession: _restoredInSession, ...portable } = receipt;
        observations.set(receipt.attribution.chargeId, {
          ...portable, attribution: { ...portable.attribution },
        });
      }
    }
    return [...observations.values()];
  }

  public isSessionProjectionComplete(): boolean {
    return this.sessionProjectionComplete;
  }

  /** Export bounded attempt receipts for owner-specific durable storage. */
  public getTaskChargeObservations(taskOwnerId: string): ChargeReceipt[] {
    return [...this.chargeObservations.values()]
      .filter((receipt) => receipt.attribution.taskOwnerId === taskOwnerId ||
        receipt.attribution.parentTaskOwnerId === taskOwnerId)
      .map(({ projectedInSession: _projectedInSession, ...receipt }) => ({
        ...receipt,
        attribution: { ...receipt.attribution },
      }));
  }

  /** Reconcile a newer owner receipt against the exact older REPL snapshot. */
  private reconcileRestoredSessionReceipt(saved: ChargeReceipt, current: ChargeReceipt): boolean {
    if (JSON.stringify(saved) === JSON.stringify(current)) return false;
    const monotone = saved.modelId === current.modelId && saved.knownCostUSD === null &&
      JSON.stringify(saved.attribution) === JSON.stringify(current.attribution) &&
      current.inputTokens >= saved.inputTokens && current.outputTokens >= saved.outputTokens &&
      current.cacheHitTokens >= saved.cacheHitTokens && current.cacheMissTokens >= saved.cacheMissTokens;
    const aggregate = this.sessionUsage['__restored__'];
    if (!monotone || !aggregate || (aggregate.unknownChargeCount ?? 0) < 1) {
      this.sessionProjectionComplete = false;
      return false;
    }
    aggregate.inputTokens -= saved.inputTokens;
    aggregate.outputTokens -= saved.outputTokens;
    aggregate.promptCacheHitTokens = (aggregate.promptCacheHitTokens ?? 0) - saved.cacheHitTokens;
    aggregate.promptCacheMissTokens = (aggregate.promptCacheMissTokens ?? 0) - saved.cacheMissTokens;
    aggregate.unknownChargeCount = (aggregate.unknownChargeCount ?? 0) - 1;
    aggregate.completeCostUSD = aggregate.unknownChargeCount === 0 ? aggregate.costUSD : null;
    const model = this.sessionUsage[current.modelId] ?? { inputTokens: 0, outputTokens: 0, costUSD: 0 };
    model.inputTokens += current.inputTokens;
    model.outputTokens += current.outputTokens;
    model.costUSD += current.knownCostUSD ?? 0;
    model.unknownChargeCount = (model.unknownChargeCount ?? 0) + (current.knownCostUSD === null ? 1 : 0);
    model.completeCostUSD = model.unknownChargeCount === 0 ? model.costUSD : null;
    model.promptCacheHitTokens = (model.promptCacheHitTokens ?? 0) + current.cacheHitTokens;
    model.promptCacheMissTokens = (model.promptCacheMissTokens ?? 0) + current.cacheMissTokens;
    this.sessionUsage[current.modelId] = model;
    this.sessionTotalCost += current.knownCostUSD ?? 0;
    this.sessionUnknownCharges += current.knownCostUSD === null ? 0 : -1;
    this.restoredProjectAttributionIncomplete = true;
    return true;
  }

  /**
   * Seed durable task spend after cold resume without adding it to this
   * process's global aggregate. Existing in-process task usage wins.
   */
  public restoreTaskUsage(
    taskOwnerId: string,
    input: { totalCostUSD: number; chargeIds: readonly string[]; unknownChargeCount?: number; chargeObservations?: readonly ChargeReceipt[] },
  ): void {
    // A live owner may have only unresolved charges and no known-cost entry.
    // Its newer receipts take precedence over a stale persisted snapshot.
    if (this.taskUsage.has(taskOwnerId) || this.taskChargeIds.has(taskOwnerId) ||
        this.taskUnknownCharges.has(taskOwnerId) || this.taskTotalCost.has(taskOwnerId)) return;
    if (input.chargeObservations) {
      const declaredIds = new Set(input.chargeIds);
      const receipts = input.chargeObservations;
      const validTokens = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
      const validOptionalId = (value: unknown) => value === undefined ||
        (typeof value === 'string' && value.length > 0);
      if (!Number.isFinite(input.totalCostUSD) || input.totalCostUSD < 0 ||
          !validTokens(input.unknownChargeCount ?? 0) ||
          input.chargeIds.some((id) => typeof id !== 'string' || id.length === 0) ||
          receipts.length !== declaredIds.size ||
          new Set(receipts.map((receipt) => receipt?.attribution?.chargeId)).size !== receipts.length ||
          receipts.some((receipt) => !receipt || !receipt.attribution ||
            typeof receipt.modelId !== 'string' || receipt.modelId.length === 0 ||
            ['__proto__', 'prototype', 'constructor'].includes(receipt.modelId) ||
            typeof receipt.attribution.taskOwnerId !== 'string' ||
            receipt.attribution.taskOwnerId.length === 0 ||
            typeof receipt.attribution.chargeId !== 'string' ||
            receipt.attribution.chargeId.length === 0 ||
            !validOptionalId(receipt.attribution.parentTaskOwnerId) ||
            !validOptionalId(receipt.attribution.accountingEpoch) ||
            !validOptionalId(receipt.attribution.turnId) ||
            !validOptionalId(receipt.attribution.requestId) ||
            !validOptionalId(receipt.attribution.attemptId) ||
            !validTokens(receipt.inputTokens) || !validTokens(receipt.outputTokens) ||
            !validTokens(receipt.cacheHitTokens) || !validTokens(receipt.cacheMissTokens) ||
            (receipt.knownCostUSD !== null &&
              (typeof receipt.knownCostUSD !== 'number' ||
               !Number.isFinite(receipt.knownCostUSD) || receipt.knownCostUSD < 0)))) {
        throw new Error('Invalid durable charge observation');
      }
      if (receipts.some((receipt) => !declaredIds.has(receipt.attribution.chargeId) ||
          (receipt.attribution.taskOwnerId !== taskOwnerId &&
           receipt.attribution.parentTaskOwnerId !== taskOwnerId))) {
        throw new Error('Durable charge observations do not match the task owner snapshot');
      }
      const knownTotal = receipts.reduce((sum, receipt) => sum + (receipt.knownCostUSD ?? 0), 0);
      const unknownTotal = receipts.filter((receipt) => receipt.knownCostUSD === null).length;
      if (Math.abs(knownTotal - input.totalCostUSD) > 1e-9 ||
          unknownTotal !== (input.unknownChargeCount ?? 0)) {
        throw new Error('Durable charge observations disagree with the task totals');
      }
      // Either durable file can be the newer checkpoint. Prefer a confirmed
      // session receipt over an older pending owner receipt, before mutating
      // any owner or session state.
      const effectiveReceipts = receipts.map((receipt) => {
        const saved = this.restoredSessionObservations?.get(receipt.attribution.chargeId);
        if (!saved || JSON.stringify(saved) === JSON.stringify(receipt)) return receipt;
        const sameIdentity = saved.modelId === receipt.modelId &&
          JSON.stringify(saved.attribution) === JSON.stringify(receipt.attribution);
        if (sameIdentity && saved.knownCostUSD !== null && receipt.knownCostUSD === null &&
            saved.inputTokens >= receipt.inputTokens && saved.outputTokens >= receipt.outputTokens &&
            saved.cacheHitTokens >= receipt.cacheHitTokens && saved.cacheMissTokens >= receipt.cacheMissTokens) {
          return saved;
        }
        if (sameIdentity && saved.knownCostUSD === null &&
            receipt.inputTokens >= saved.inputTokens && receipt.outputTokens >= saved.outputTokens &&
            receipt.cacheHitTokens >= saved.cacheHitTokens && receipt.cacheMissTokens >= saved.cacheMissTokens) {
          return receipt;
        }
        throw new Error('Conflicting durable charge checkpoints');
      });
      for (const receipt of effectiveReceipts) {
        const previous = this.chargeObservations.get(receipt.attribution.chargeId);
        if (previous && JSON.stringify({ ...previous, projectedInSession: false, restoredInSession: undefined }) !==
            JSON.stringify({ ...receipt, projectedInSession: false, restoredInSession: undefined })) {
          throw new Error('Conflicting durable charge observation');
        }
      }
      for (const receipt of effectiveReceipts) {
        const previous = this.chargeObservations.get(receipt.attribution.chargeId);
        const saved = this.restoredSessionObservations?.get(receipt.attribution.chargeId);
        const reconciled = !previous && saved
          ? this.reconcileRestoredSessionReceipt(saved, receipt) : false;
        if (!previous) this.chargeObservations.set(receipt.attribution.chargeId, {
          ...receipt, attribution: { ...receipt.attribution },
          projectedInSession: this.restoredSessionChargeIds?.has(receipt.attribution.chargeId) ?? false,
          restoredInSession: (this.restoredSessionChargeIds?.has(receipt.attribution.chargeId) ?? false) && !reconciled,
        });
        if (saved) this.restoredSessionObservations?.set(receipt.attribution.chargeId, receipt);
        this.recordedChargeIds.add(receipt.attribution.chargeId);
        this.recordTaskUsage(taskOwnerId, receipt.attribution.chargeId, receipt.modelId,
          receipt.inputTokens, receipt.outputTokens, receipt.knownCostUSD ?? 0,
          receipt.knownCostUSD === null ? 1 : 0, receipt.cacheHitTokens, receipt.cacheMissTokens);
      }
      if (receipts.length === 0) {
        this.taskUsage.set(taskOwnerId, {});
        this.taskChargeIds.set(taskOwnerId, new Set());
      }
      return;
    }
    this.taskTotalCost.set(taskOwnerId, input.totalCostUSD);
    this.taskUnknownCharges.set(taskOwnerId, input.unknownChargeCount ?? 0);
    this.taskUsage.set(
      taskOwnerId,
      input.totalCostUSD > 0
        ? {
            __restored__: {
              inputTokens: 0,
              outputTokens: 0,
              costUSD: input.totalCostUSD,
            },
          }
        : {},
    );
    const charges = this.taskChargeIds.get(taskOwnerId) ?? new Set<string>();
    for (const chargeId of input.chargeIds) {
      charges.add(chargeId);
      this.recordedChargeIds.add(chargeId);
    }
    this.taskChargeIds.set(taskOwnerId, charges);
  }

  public saveToProjectStats(sessionId: string, baseline?: SessionUsageSummary, projectRoot?: string): void {
    const statsPath = projectRoot ? join(projectRoot, 'project_stats.json') : this.projectStatsPath;
    const lockPath = `${statsPath}.lock`;
    let lockFd: number;
    try {
      lockFd = openSync(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const before = statSync(lockPath);
      if (Date.now() - before.mtimeMs < 60_000) throw error;
      let ownerPid: number | null = null;
      try {
        const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && Number.isSafeInteger((parsed as { pid?: unknown }).pid)) {
          ownerPid = (parsed as { pid: number }).pid;
        }
      } catch {
        // An interrupted lock write has no valid owner record.
      }
      if (ownerPid !== null && ownerPid > 0) {
        try {
          process.kill(ownerPid, 0);
          throw error;
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe;
        }
      }
      const after = statSync(lockPath);
      if (after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.size !== before.size) throw error;
      unlinkSync(lockPath);
      lockFd = openSync(lockPath, 'wx');
    }
    try {
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      this.saveToProjectStatsLocked(sessionId, baseline, statsPath);
    } finally {
      closeSync(lockFd);
      unlinkSync(lockPath);
    }
  }

  private saveToProjectStatsLocked(sessionId: string, baseline: SessionUsageSummary | undefined, statsPath: string): void {
    let stats: ProjectStats = {
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      modelBreakdown: {},
    };

    if (existsSync(statsPath)) {
      stats = JSON.parse(readFileSync(statsPath, 'utf-8')) as ProjectStats;
    }
    let overlapsLegacySession = false;
    if (!stats.sessionSnapshots) {
      const hasLegacy = stats.totalCostUSD !== 0 || stats.totalInputTokens !== 0 ||
        stats.totalOutputTokens !== 0 || (stats.unknownChargeCount ?? 0) !== 0;
      overlapsLegacySession = hasLegacy && stats.lastSessionId === sessionId;
      stats.sessionSnapshots = hasLegacy
        ? { __legacy__: {
            totalCostUSD: stats.totalCostUSD,
            totalInputTokens: stats.totalInputTokens,
            totalOutputTokens: stats.totalOutputTokens,
            totalTokens: stats.totalInputTokens + stats.totalOutputTokens,
            unknownChargeCount: stats.unknownChargeCount ?? 0,
            modelBreakdown: stats.modelBreakdown,
          } }
        : {};
      stats.projectionComplete = !hasLegacy;
    }
    // The old format has only an aggregate and last-session label; its
    // contribution from that session cannot be separated safely.
    stats.projectionComplete = stats.projectionComplete !== false && this.sessionProjectionComplete &&
      !this.restoredProjectAttributionIncomplete;
    if (!overlapsLegacySession) {
      const current = this.getSessionSummary();
      const delta = baseline ? {
        ...current,
        totalCostUSD: current.totalCostUSD - baseline.totalCostUSD,
        totalInputTokens: current.totalInputTokens - baseline.totalInputTokens,
        totalOutputTokens: current.totalOutputTokens - baseline.totalOutputTokens,
        totalTokens: current.totalTokens - baseline.totalTokens,
        unknownChargeCount: (current.unknownChargeCount ?? 0) - (baseline.unknownChargeCount ?? 0),
        modelBreakdown: Object.fromEntries([...new Set([
          ...Object.keys(current.modelBreakdown), ...Object.keys(baseline.modelBreakdown),
        ])].map((modelId) => {
          const after = current.modelBreakdown[modelId];
          const before = baseline.modelBreakdown[modelId];
          return [modelId, {
            inputTokens: (after?.inputTokens ?? 0) - (before?.inputTokens ?? 0),
            outputTokens: (after?.outputTokens ?? 0) - (before?.outputTokens ?? 0),
            costUSD: (after?.costUSD ?? 0) - (before?.costUSD ?? 0),
            unknownChargeCount: (after?.unknownChargeCount ?? 0) - (before?.unknownChargeCount ?? 0),
            promptCacheHitTokens: (after?.promptCacheHitTokens ?? 0) - (before?.promptCacheHitTokens ?? 0),
            promptCacheMissTokens: (after?.promptCacheMissTokens ?? 0) - (before?.promptCacheMissTokens ?? 0),
          }];
        })),
      } : current;
      const prior = baseline ? stats.sessionSnapshots[sessionId] : undefined;
      stats.sessionSnapshots[sessionId] = prior ? {
        ...delta,
        totalCostUSD: prior.totalCostUSD + delta.totalCostUSD,
        totalInputTokens: prior.totalInputTokens + delta.totalInputTokens,
        totalOutputTokens: prior.totalOutputTokens + delta.totalOutputTokens,
        totalTokens: prior.totalTokens + delta.totalTokens,
        unknownChargeCount: (prior.unknownChargeCount ?? 0) + (delta.unknownChargeCount ?? 0),
        modelBreakdown: Object.fromEntries([...new Set([
          ...Object.keys(prior.modelBreakdown), ...Object.keys(delta.modelBreakdown),
        ])].map((modelId) => {
          const before = prior.modelBreakdown[modelId];
          const after = delta.modelBreakdown[modelId];
          return [modelId, {
            inputTokens: (before?.inputTokens ?? 0) + (after?.inputTokens ?? 0),
            outputTokens: (before?.outputTokens ?? 0) + (after?.outputTokens ?? 0),
            costUSD: (before?.costUSD ?? 0) + (after?.costUSD ?? 0),
            unknownChargeCount: (before?.unknownChargeCount ?? 0) + (after?.unknownChargeCount ?? 0),
            promptCacheHitTokens: (before?.promptCacheHitTokens ?? 0) + (after?.promptCacheHitTokens ?? 0),
            promptCacheMissTokens: (before?.promptCacheMissTokens ?? 0) + (after?.promptCacheMissTokens ?? 0),
          }];
        })),
      } : delta;
      if ((stats.sessionSnapshots[sessionId].unknownChargeCount ?? 0) < 0) {
        stats.projectionComplete = false;
      }
      stats.lastSessionId = sessionId;
    }
    stats.totalCostUSD = 0;
    stats.totalInputTokens = 0;
    stats.totalOutputTokens = 0;
    stats.unknownChargeCount = 0;
    stats.modelBreakdown = {};
    for (const snapshot of Object.values(stats.sessionSnapshots)) {
      stats.totalCostUSD += snapshot.totalCostUSD;
      stats.totalInputTokens += snapshot.totalInputTokens;
      stats.totalOutputTokens += snapshot.totalOutputTokens;
      stats.unknownChargeCount += snapshot.unknownChargeCount ?? 0;
      for (const [modelId, usage] of Object.entries(snapshot.modelBreakdown)) {
        const model = stats.modelBreakdown[modelId] ?? { inputTokens: 0, outputTokens: 0, costUSD: 0 };
        model.inputTokens += usage.inputTokens;
        model.outputTokens += usage.outputTokens;
        model.costUSD += usage.costUSD;
        model.unknownChargeCount = (model.unknownChargeCount ?? 0) + (usage.unknownChargeCount ?? 0);
        model.promptCacheHitTokens = (model.promptCacheHitTokens ?? 0) + (usage.promptCacheHitTokens ?? 0);
        model.promptCacheMissTokens = (model.promptCacheMissTokens ?? 0) + (usage.promptCacheMissTokens ?? 0);
        stats.modelBreakdown[modelId] = model;
      }
    }
    for (const model of Object.values(stats.modelBreakdown)) {
      model.completeCostUSD = (model.unknownChargeCount ?? 0) === 0 ? model.costUSD : null;
    }
    stats.completeCostUSD = stats.unknownChargeCount === 0 && stats.projectionComplete !== false
      ? stats.totalCostUSD : null;

    const tmpPath = `${statsPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(tmpPath, JSON.stringify(stats, null, 2));
      renameSync(tmpPath, statsPath);
    } finally {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    }

    // Also upsert the session summary into SQLite for historical queries.
    // This is additive — JSON project_stats.json remains as the primary store.
    if (!overlapsLegacySession) this._upsertSessionSummaryToSqlite(sessionId, stats.sessionSnapshots[sessionId]!, dirname(statsPath));
  }

  /**
   * Upsert the current session's usage summary into the SQLite session_summary table.
   * Best-effort — failures are caught silently.
   */
  private _upsertSessionSummaryToSqlite(sessionId: string, summary: SessionUsageSummary, projectRoot: string): void {
    try {
      const db = getGlobalTokenHistoryDb();
      const scopedSessionId = `${sessionId}:${createHash('sha256').update(projectRoot).digest('hex')}`;
      db.upsertSessionSummary(scopedSessionId, {
        startedAt: Date.now(),
        endedAt: null,
        totalInputTokens: summary.totalInputTokens,
        totalOutputTokens: summary.totalOutputTokens,
        totalCost: summary.totalCostUSD,
        unknownChargeCount: summary.unknownChargeCount ?? 0,
        turnCount: 1, // Each saveToProjectStats call counts as a batch save point
        projectRoot,
      });
    } catch {
      // Best-effort — silent if DB is unavailable
    }
  }

  /**
   * Query historical total cost for a project from SQLite.
   * Returns 0 if the database is unavailable or has no records.
   */
  public getProjectHistoricalCost(projectRoot?: string): number | null {
    try {
      const root = projectRoot ?? dirname(this.projectStatsPath);
      const statsPath = join(root, 'project_stats.json');
      if (existsSync(statsPath)) {
        const stats = JSON.parse(readFileSync(statsPath, 'utf-8')) as ProjectStats;
        if (stats.projectionComplete === false) return null;
      }
      const db = getGlobalTokenHistoryDb();
      const cost = db.getProjectCostSummary(root);
      return cost && cost.unknownChargeCount === 0 ? cost.knownCostUSD : null;
    } catch {
      return null;
    }
  }
}

// Singleton for easy access in CLI turns
export const globalCostTracker = new CostTracker();
