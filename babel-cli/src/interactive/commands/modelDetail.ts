// ─── Model Detail — operator surface for model identity, routing, and health ──
// Backs `/model show|why|health` in the REPL and `babel models list` in the CLI.
// Presentation only: every fact comes from the canonical model policy, the
// credential hub, and the latest run bundle. No network access and no
// second source of truth — this module renders what modelPolicy.ts resolves.
//
// Epistemic rules for this surface:
// - Configuration is never presented as health. Credential presence proves
//   nothing about validity; a configured fallback is never "ready".
// - Historical telemetry is labeled with its stage and timestamp.
// - Unknown stays unknown: cost, upstream, and qualification each render
//   an explicit unknown marker instead of a plausible default.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveChatModelPolicy, isOfflineChatMode } from '../../agent/chatModelPolicy.js';
import {
  getAvailableModels,
  getPolicyPath,
  validateModelPolicyMetadataFreshness,
  type ModelPolicyModelEntry,
  type ResolvedModelPolicy,
  type ResolvedModelPolicyEntry,
} from '../../modelPolicy.js';
import { getProviderCredentialStatus } from '../../runners/credentialHub.js';
import { redactSecrets } from '../../utils/redaction.js';
import { getRecentRuns } from '../utils.js';
import { accentBright, muted, padRight, warning } from '../../ui/theme.js';
import { findModelProfile } from '../../intelligence/catalog.js';
import { modelRefKey, type ModelRef } from '../../intelligence/model-ref.js';
import { resolvePriceQuote, type PriceQuoteResult } from '../../intelligence/price-quote.js';
import {
  evaluateRouteAdmission,
  resolveModelSelection,
  type ConfiguredRoute,
  type ModelAliasDeclaration,
  type ModelSelectionResult,
  type ModelSelectionSuccess,
  type RouteAdmissionDecision,
  type RouteAuthorizationEntry,
} from '../../intelligence/route-selection.js';
import type {
  CapabilityObservation,
  CatalogSnapshot,
  ExecutionMode,
  LabModelSpec,
  ProtocolProfile,
  ProviderModelProfile,
} from '../../intelligence/types.js';
import {
  getProviderSpec,
  isProviderId,
  type ProviderId,
  type ProviderPurpose,
} from '../../runners/providerRegistry.js';
import { loadLiteCatalogSnapshot } from '../../lite/config.js';
import {
  loadModelPolicyConfig,
  type ValidatedModelPolicy,
} from '../../modelPolicy.js';

/** Resolved model identity plus where the choice came from. */
export interface ModelSnapshot {
  source: 'session' | 'auto';
  offline: boolean;
  policy: ResolvedModelPolicy;
}

/** Structural subset of one attempt in `05_waterfall_telemetry.json`. */
interface WaterfallAttemptTelemetry {
  tier_name?: string;
  succeeded?: boolean;
  provider?: string | null;
  provider_model_id?: string | null;
  upstream_provider?: string | null;
  error_summary?: string | null;
}

/** Structural subset of a `WaterfallOutcome` record in `05_waterfall_telemetry.json`. */
interface WaterfallTelemetryEntry {
  stage?: string;
  tier_succeeded?: string;
  tier_index?: number;
  tiers_skipped?: string[];
  cascade_reason?: string;
  ts?: string;
  attempts_detail?: WaterfallAttemptTelemetry[];
}

/** Structural subset of the serialized RoutingDecision in `debug_dynamic_routing_*.json`. */
interface DynamicRoutingDebugEntry {
  stage?: string;
  selectedName?: string;
  selectedIndex?: number;
  telemetryRunsScanned?: number;
  reason?: string;
}

/** Structural subset of `provider_failure_receipt` events in `session-events.jsonl`. */
export interface FailureReceiptFacts {
  provider: string | null;
  exactModelId: string | null;
  upstreamProvider: string | null;
  failureClass: string | null;
  httpStatus: number | null;
  retryable: boolean | null;
  ts: string | null;
}

export interface LastRouteFacts {
  runDir: string;
  lastWaterfall: WaterfallTelemetryEntry | null;
  /** Routing decision correlated to the last waterfall record's stage, when one was recorded. */
  dynamicRouting: DynamicRoutingDebugEntry | null;
  /** True when the last waterfall stage has no matching dynamic-routing debug artifact. */
  dynamicRoutingMissingForStage: boolean;
  failureReceipts: FailureReceiptFacts[];
}

// ─── Snapshot cache ───────────────────────────────────────────────────────────
// The REPL status bar renders this snapshot repeatedly, so resolution is
// cached — but keyed on the policy file's mtime/size and the offline flag so
// policy edits, BABEL_MODEL_POLICY_PATH changes, and offline/live lane flips
// re-resolve instead of serving stale state. /model set|clear reset it
// explicitly because they change the session override, not the file.

interface SnapshotCacheKey {
  sessionModel: string;
  offline: boolean;
  policyPath: string;
  mtimeMs: number;
  size: number;
}

let snapshotCache: { key: SnapshotCacheKey; snapshot: ModelSnapshot | null } | null = null;

function policyFileStamp(): { path: string; mtimeMs: number; size: number } {
  const policyPath = getPolicyPath();
  try {
    const stats = fs.statSync(policyPath);
    return { path: policyPath, mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return { path: policyPath, mtimeMs: -1, size: -1 };
  }
}

/**
 * Resolve the model snapshot for display: the session override when set,
 * otherwise the policy default (offline-aware, live lane by default).
 * Returns null when the policy cannot be resolved at all.
 */
export function resolveModelSnapshot(sessionModel?: string): ModelSnapshot | null {
  const offline = isOfflineChatMode();
  const stamp = policyFileStamp();
  const key: SnapshotCacheKey = {
    sessionModel: sessionModel ?? '',
    offline,
    policyPath: stamp.path,
    mtimeMs: stamp.mtimeMs,
    size: stamp.size,
  };
  if (snapshotCache && JSON.stringify(snapshotCache.key) === JSON.stringify(key)) {
    return snapshotCache.snapshot;
  }
  let snapshot: ModelSnapshot | null;
  try {
    const resolved = resolveChatModelPolicy(sessionModel ? { model: sessionModel } : {});
    snapshot = { source: sessionModel ? 'session' : 'auto', offline, policy: resolved.policy };
  } catch {
    snapshot = null;
  }
  snapshotCache = { key, snapshot };
  return snapshot;
}

/** Invalidate the cached snapshot (call after /model set|clear). */
export function resetModelSnapshotCache(): void {
  snapshotCache = null;
}

/** Status-bar/header label: session override, else the resolved default key, else 'auto'. */
export function resolveStatusBarModelLabel(sessionModel: string | undefined): string {
  if (sessionModel) return sessionModel;
  const snapshot = resolveModelSnapshot(undefined);
  return snapshot ? snapshot.policy.resolvedBackendKey : 'auto';
}

function findPolicyEntry(backendKey: string): ModelPolicyModelEntry | undefined {
  return getAvailableModels().find((m) => m.key === backendKey)?.entry;
}

function formatContextTokens(value: number | undefined): string {
  if (!value || value <= 0) return 'unknown';
  return value >= 1000 ? `${Math.round(value / 1000)}k tokens` : `${value} tokens`;
}

/** Next fallback tier after the currently selected backend, if any. */
export function nextFallbackEntry(policy: ResolvedModelPolicy): ResolvedModelPolicyEntry | null {
  // Canonical policy builders always include the resolved backend in the
  // waterfall. A key that is not in the waterfall has no demonstrable
  // fallback — report none rather than inventing one from waterfall[0].
  const index = policy.waterfall.findIndex((e) => e.backendKey === policy.resolvedBackendKey);
  if (index >= 0 && index + 1 < policy.waterfall.length) return policy.waterfall[index + 1]!;
  return null;
}

function formatEntryMetadata(entry: ModelPolicyModelEntry | undefined): string | null {
  if (!entry) return null;
  const parts: string[] = [];
  if (entry.verified_at) parts.push(`verified ${entry.verified_at}`);
  if (entry.expires_at) parts.push(`expires ${entry.expires_at}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

// ─── Run-bundle facts (historical observations only) ─────────────────────────

function readWaterfallTelemetry(runDir: string): WaterfallTelemetryEntry | null {
  try {
    const telemetryPath = path.join(runDir, '05_waterfall_telemetry.json');
    if (!fs.existsSync(telemetryPath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(telemetryPath, 'utf-8'));
    if (Array.isArray(parsed) && parsed.length > 0) {
      return (parsed[parsed.length - 1] ?? null) as WaterfallTelemetryEntry | null;
    }
  } catch {
    /* telemetry is optional */
  }
  return null;
}

function readRoutingDecisionForStage(runDir: string, stage: string): DynamicRoutingDebugEntry | null {
  // The debug filename embeds the stage label it was written for, so the
  // last waterfall record's stage is the canonical join key. Filename
  // ordering across stages says nothing about execution order.
  const fileName = `debug_dynamic_routing_${stage}.json`;
  try {
    const decisionPath = path.join(runDir, fileName);
    if (!fs.existsSync(decisionPath)) return null;
    return JSON.parse(fs.readFileSync(decisionPath, 'utf-8')) as DynamicRoutingDebugEntry;
  } catch {
    return null;
  }
}

function readFailureReceipts(runDir: string): FailureReceiptFacts[] {
  try {
    const eventsPath = path.join(runDir, 'session-events.jsonl');
    if (!fs.existsSync(eventsPath)) return [];
    const receipts: FailureReceiptFacts[] = [];
    for (const line of fs.readFileSync(eventsPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as {
          kind?: string;
          ts?: string;
          receipt?: {
            provider?: string;
            exact_model_id?: string;
            upstream_provider?: string | null;
            normalized_failure_class?: string;
            http_status?: number | null;
            retryable?: boolean;
          };
        };
        if (event.kind !== 'provider_failure_receipt' || !event.receipt) continue;
        receipts.push({
          provider: event.receipt.provider ?? null,
          exactModelId: event.receipt.exact_model_id ?? null,
          upstreamProvider: event.receipt.upstream_provider ?? null,
          failureClass: event.receipt.normalized_failure_class ?? null,
          httpStatus: event.receipt.http_status ?? null,
          retryable: event.receipt.retryable ?? null,
          ts: event.ts ?? null,
        });
      } catch {
        /* malformed lines are skipped; receipts are optional evidence */
      }
    }
    return receipts;
  } catch {
    return [];
  }
}

/**
 * Read routing facts from the most recent run bundle (waterfall telemetry and
 * the per-stage dynamic-routing decision correlated to the last waterfall
 * stage). Returns null when no run data exists.
 */
export function readLastRouteFacts(lastRunDir?: string | null): LastRouteFacts | null {
  const runDir = lastRunDir ?? getRecentRuns(1)[0];
  if (!runDir || !fs.existsSync(runDir)) return null;
  const lastWaterfall = readWaterfallTelemetry(runDir);
  let dynamicRouting: DynamicRoutingDebugEntry | null = null;
  let dynamicRoutingMissingForStage = false;
  if (lastWaterfall?.stage) {
    dynamicRouting = readRoutingDecisionForStage(runDir, lastWaterfall.stage);
    dynamicRoutingMissingForStage = dynamicRouting === null;
  }
  const failureReceipts = readFailureReceipts(runDir);
  if (!lastWaterfall && !dynamicRouting && failureReceipts.length === 0) return null;
  return { runDir, lastWaterfall, dynamicRouting, dynamicRoutingMissingForStage, failureReceipts };
}

function formatStageAndTime(entry: WaterfallTelemetryEntry): string {
  const parts: string[] = [];
  if (entry.stage) parts.push(`stage '${entry.stage}'`);
  if (entry.ts) parts.push(entry.ts);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** Most recent observed upstream for the winning attempt, if the gateway exposed one. */
function lastObservedUpstream(wf: WaterfallTelemetryEntry | null): {
  upstream: string;
  ts: string | null;
} | null {
  if (!wf) return null;
  const attempts = Array.isArray(wf.attempts_detail) ? wf.attempts_detail : [];
  const winner = [...attempts].reverse().find((a) => a.succeeded === true && a.upstream_provider);
  if (winner?.upstream_provider) {
    return { upstream: winner.upstream_provider, ts: wf.ts ?? null };
  }
  return null;
}

export interface ModelWhyInput {
  sessionModel?: string | undefined;
  lastRoutingLabel?: string | null | undefined;
  lastRunDir?: string | null | undefined;
}

/** Explain why the current model is serving this session, and what ran last. */
export function renderModelWhy(input: ModelWhyInput = {}): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${accentBright('Why This Model')}`);
  const snapshot = resolveModelSnapshot(input.sessionModel);
  if (!snapshot) {
    lines.push(muted('    Model policy could not be resolved — run /doctor for details.'));
    return lines.join('\n');
  }
  const { policy } = snapshot;
  if (snapshot.source === 'session') {
    lines.push(
      `    ${muted(padRight('Selection', 14))} You set this model for the session ${muted('(/model clear to use the policy default)')}`,
    );
  } else {
    lines.push(
      `    ${muted(padRight('Selection', 14))} Auto — policy default for the ${snapshot.offline ? 'offline lane' : 'live lane'}`,
    );
  }
  const reason =
    policy.selectionReason ??
    policy.tierSelectionReason ??
    findPolicyEntry(policy.resolvedBackendKey)?.selection_reason;
  if (reason) {
    lines.push(`    ${muted(padRight('Reason', 14))} ${muted(reason)}`);
  }
  if (input.lastRoutingLabel) {
    lines.push(
      `    ${muted(padRight('Last turn', 14))} served by ${accentBright(input.lastRoutingLabel)}`,
    );
  }
  const facts = readLastRouteFacts(input.lastRunDir);
  if (facts?.lastWaterfall) {
    const wf = facts.lastWaterfall;
    const context = muted(formatStageAndTime(wf));
    const skipped = Array.isArray(wf.tiers_skipped) ? wf.tiers_skipped : [];
    if ((wf.tier_index ?? 0) > 0 || skipped.length > 0) {
      lines.push(
        `    ${muted(padRight('Last run', 14))} ${warning(`fallback used — succeeded on '${wf.tier_succeeded ?? 'unknown'}'`)}${context}${skipped.length > 0 ? muted(` after ${skipped.join(', ')} (${wf.cascade_reason ? redactSecrets(wf.cascade_reason) : 'reason not recorded'})`) : ''} ${muted('(historical)')}`,
      );
    } else if (wf.tier_succeeded) {
      lines.push(
        `    ${muted(padRight('Last run', 14))} first-tier success on ${accentBright(wf.tier_succeeded)}${context} ${muted('(historical)')}`,
      );
    }
    const upstream = lastObservedUpstream(wf);
    if (upstream) {
      lines.push(
        `    ${muted(padRight('Last upstream', 14))} ${accentBright(upstream.upstream)} ${muted(`(observed${upstream.ts ? ` at ${upstream.ts}` : ''} — historical, not a guarantee of the next request)`)}`,
      );
    } else if (Array.isArray(wf.attempts_detail) && wf.attempts_detail.length > 0) {
      lines.push(
        `    ${muted(padRight('Last upstream', 14))} ${muted('not recorded — gateway did not expose a serving upstream')}`,
      );
    }
  } else {
    lines.push(`    ${muted(padRight('Last run', 14))} ${muted('no run telemetry yet')}`);
  }
  if (facts?.dynamicRouting?.selectedName) {
    const dr = facts.dynamicRouting;
    const stageLabel = dr.stage ?? facts.lastWaterfall?.stage;
    lines.push(
      `    ${muted(padRight('Routing', 14))} ${muted(`dynamic routing for stage '${stageLabel ?? 'unknown'}' preferred '${dr.selectedName}'${dr.reason ? ` — ${dr.reason}` : ''}`)}`,
    );
  } else if (facts?.dynamicRoutingMissingForStage && facts.lastWaterfall?.stage) {
    lines.push(
      `    ${muted(padRight('Routing', 14))} ${muted(`no dynamic-routing decision recorded for stage '${facts.lastWaterfall.stage}'`)}`,
    );
  }
  return lines.join('\n');
}

/** Credential description that never equates presence with validity. */
function describeCredential(
  provider: string,
  env: NodeJS.ProcessEnv,
): { state: 'not_required' | 'present' | 'missing' | 'unknown'; text: string; isWarning: boolean } {
  try {
    const cred = getProviderCredentialStatus(provider as Parameters<typeof getProviderCredentialStatus>[0], env);
    if (!cred.required) {
      return { state: 'not_required', text: 'not required for this provider', isWarning: false };
    }
    if (cred.configured) {
      return {
        state: 'present',
        text: `${cred.envVar} set — presence only; validity, quota, and reachability not verified`,
        isWarning: false,
      };
    }
    return {
      state: 'missing',
      text: `${cred.envVar} not set — provider requests will fail until it is configured`,
      isWarning: true,
    };
  } catch {
    return {
      state: 'unknown',
      text: `credential state unknown — provider '${provider}' has no registry spec`,
      isWarning: true,
    };
  }
}

/**
 * One observation tier for the resolved backend, built only from run-bundle
 * evidence. Never issues network traffic and never claims reachability.
 */
function describeObservations(facts: LastRouteFacts | null): { text: string; isWarning: boolean } | null {
  const wf = facts?.lastWaterfall ?? null;
  if (!wf) {
    return facts
      ? { text: 'no waterfall observations in the most recent run bundle', isWarning: false }
      : null;
  }
  const context = formatStageAndTime(wf);
  const attempts = Array.isArray(wf.attempts_detail) ? wf.attempts_detail : [];
  const lastSuccess = [...attempts].reverse().find((a) => a.succeeded === true);
  const lastFailure = [...attempts].reverse().find((a) => a.succeeded === false);
  if (lastSuccess) {
    return {
      text: `success on '${lastSuccess.tier_name ?? wf.tier_succeeded ?? 'unknown'}'${context}${lastSuccess.upstream_provider ? muted(` — upstream '${lastSuccess.upstream_provider}'`) : ''} (historical)`,
      isWarning: false,
    };
  }
  if (lastFailure) {
    const detail = lastFailure.error_summary
      ? ` — ${redactSecrets(lastFailure.error_summary.slice(0, 120))}`
      : '';
    return {
      text: `failure on '${lastFailure.tier_name ?? 'unknown'}'${context}${detail} (historical)`,
      isWarning: true,
    };
  }
  if (wf.tier_succeeded) {
    return { text: `success on '${wf.tier_succeeded}'${context} (historical)`, isWarning: false };
  }
  if ((wf.tier_index ?? 0) > 0) {
    return {
      text: `fallback used${context}${wf.cascade_reason ? ` (${redactSecrets(wf.cascade_reason)})` : ''} (historical)`,
      isWarning: true,
    };
  }
  return { text: `no attempt-level observations in the most recent run bundle${context}`, isWarning: false };
}

function describeFailureReceipts(
  policy: ResolvedModelPolicy,
  facts: LastRouteFacts | null,
): string | null {
  const receipts = (facts?.failureReceipts ?? []).filter(
    (r) => r.provider === policy.provider && r.exactModelId === policy.providerModelId,
  );
  if (receipts.length === 0) return null;
  const mostRecent = receipts[receipts.length - 1]!;
  const bits: string[] = [];
  if (mostRecent.failureClass) bits.push(mostRecent.failureClass);
  if (mostRecent.httpStatus !== null) bits.push(`HTTP ${mostRecent.httpStatus}`);
  if (mostRecent.retryable === false) bits.push('not retryable');
  return `${receipts.length} failure receipt(s) in the last run — most recent ${bits.join(' · ') || 'class not recorded'}${mostRecent.ts ? ` at ${mostRecent.ts}` : ''}`;
}

export interface ModelHealthOptions {
  env?: NodeJS.ProcessEnv;
  lastRunDir?: string | null | undefined;
}

/**
 * Route health for an already-resolved snapshot: policy state, credential
 * presence (never validity), metadata freshness, recorded observations, and
 * live-reachability status. Reads only local canonical state — no network
 * calls, no implicit live probing.
 */
export function renderModelHealthForSnapshot(
  snapshot: ModelSnapshot,
  options: ModelHealthOptions = {},
): string {
  const env = options.env ?? process.env;
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${accentBright('Model Health')}`);
  const { policy } = snapshot;
  lines.push(`    ${muted(padRight('Backend', 14))} ${accentBright(policy.resolvedBackendKey)}`);
  const flags: string[] = [policy.enabled ? 'enabled' : warning('disabled')];
  if (policy.experimental) flags.push(muted('experimental'));
  if (policy.blockedWithoutExplicitOptIn) flags.push(muted('opt-in required'));
  lines.push(`    ${muted(padRight('Policy', 14))} ${flags.join(' · ')}`);
  const credential = describeCredential(policy.provider, env);
  lines.push(
    `    ${muted(padRight('Credential', 14))} ${credential.isWarning ? warning(credential.text) : credential.text}`,
  );
  const freshness = validateModelPolicyMetadataFreshness();
  if (freshness.status === 'pass') {
    lines.push(`    ${muted(padRight('Metadata', 14))} ${accentBright('fresh')} ${muted('— pricing/context provenance verified')}`);
  } else {
    lines.push(
      `    ${muted(padRight('Metadata', 14))} ${warning(`${freshness.issues.length} metadata issue(s)`)}`,
    );
    for (const issue of freshness.issues.slice(0, 3)) {
      lines.push(`      ${muted(`- ${issue}`)}`);
    }
  }
  lines.push(
    `    ${muted(padRight('Qualification', 14))} ${muted('not recorded — no live qualification evidence exists for this route')}`,
  );
  const facts = readLastRouteFacts(options.lastRunDir);
  const observations = describeObservations(facts);
  if (observations) {
    lines.push(
      `    ${muted(padRight('Observed', 14))} ${observations.isWarning ? warning(observations.text) : observations.text}`,
    );
  } else {
    lines.push(
      `    ${muted(padRight('Observed', 14))} ${muted('not observed — no run bundle available on this machine')}`,
    );
  }
  const receiptSummary = describeFailureReceipts(policy, facts);
  if (receiptSummary) {
    lines.push(`    ${muted(padRight('Receipts', 14))} ${warning(receiptSummary)}`);
  }
  lines.push(
    `    ${muted(padRight('Reachability', 14))} ${muted('live reachability not checked by this surface')}`,
  );
  lines.push(
    muted(`    To verify live: babel models ping --i-authorize-live --model ${policy.resolvedBackendKey}`),
  );
  const fallback = nextFallbackEntry(policy);
  if (fallback) {
    const fallbackCredential = describeCredential(fallback.provider, env);
    lines.push(
      `    ${muted(padRight('Fallback', 14))} ${fallback.backendKey} ${muted(`(${fallback.provider} → ${fallback.providerModelId})`)} — configured${fallbackCredential.state === 'missing' ? warning(' · credential missing') : ''}${muted(' · readiness not verified')}`,
    );
  } else {
    lines.push(`    ${muted(padRight('Fallback', 14))} ${muted('none configured — single-tier route')}`);
  }
  return lines.join('\n');
}

/**
 * Route health for the active model: resolves the snapshot, then renders the
 * honest health tiers (see renderModelHealthForSnapshot).
 */
export function renderModelHealth(
  sessionModel?: string,
  env: NodeJS.ProcessEnv = process.env,
  lastRunDir?: string | null,
): string {
  const snapshot = resolveModelSnapshot(sessionModel);
  if (!snapshot) {
    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${accentBright('Model Health')}`);
    lines.push(muted('    Model policy could not be resolved — run /doctor for details.'));
    return lines.join('\n');
  }
  return renderModelHealthForSnapshot(snapshot, { env, lastRunDir });
}

/**
 * One compact screen describing the active model, route, cost, and fallback.
 *
 * When a canonical availability projection is supplied (see
 * {@link ModelAvailabilityView}) its effective admission, freshness, limits,
 * capability-evidence and price-provenance rows are appended. The projection is
 * presentation-only: every admitted/blocked fact is copied from the shared
 * route-selection gate, never minted here.
 */
export function renderModelDetail(
  snapshot: ModelSnapshot,
  availability?: ModelAvailabilityView,
): string {
  const { policy } = snapshot;
  const lines: string[] = [];
  const sourceLabel =
    snapshot.source === 'session'
      ? 'session override'
      : snapshot.offline
        ? 'auto · offline policy'
        : 'auto · policy default';
  lines.push('');
  lines.push(`  ${accentBright('Model Detail')}  ${muted(`(${sourceLabel})`)}`);
  lines.push(`    ${muted(padRight('Backend', 10))} ${accentBright(policy.resolvedBackendKey)}${policy.experimental ? muted(' · experimental') : ''}`);
  lines.push(
    `    ${muted(padRight('Provider', 10))} ${accentBright(policy.provider)} ${muted('→')} ${muted(policy.providerModelId)}`,
  );
  const contextWindow = policy.contextWindow ?? policy.contextLimit;
  const contextParts = [formatContextTokens(contextWindow)];
  if (policy.maxOutputTokens) contextParts.push(`output up to ${formatContextTokens(policy.maxOutputTokens)}`);
  if (policy.nativeToolUse) contextParts.push('native tools');
  lines.push(`    ${muted(padRight('Context', 10))} ${contextParts.join(' · ')}`);
  const costParts: string[] = [];
  // The per-run estimate is derived from the per-M costs; when the policy
  // publishes neither, the resolver's ~$0.0000/run default is a fabricated
  // zero, not a fact — unknown cost stays unknown.
  const hasPublishedCost =
    policy.estimatedCostPer1MInput !== undefined || policy.estimatedCostPer1MOutput !== undefined;
  if (policy.approximateCostPerRunUsd !== undefined && hasPublishedCost) {
    costParts.push(`~$${policy.approximateCostPerRunUsd.toFixed(4)}/run`);
  }
  if (policy.estimatedCostPer1MInput !== undefined) {
    costParts.push(`$${policy.estimatedCostPer1MInput}/M in`);
  }
  if (policy.estimatedCostPer1MOutput !== undefined) {
    costParts.push(`$${policy.estimatedCostPer1MOutput}/M out`);
  }
  if (costParts.length === 0) {
    costParts.push(muted('cost unknown — not published in model policy'));
  }
  lines.push(`    ${muted(padRight('Cost', 10))} ${costParts.join(' · ')}`);
  const metadata = formatEntryMetadata(findPolicyEntry(policy.resolvedBackendKey));
  if (metadata) {
    lines.push(`    ${muted(padRight('Metadata', 10))} ${muted(metadata)}`);
  }
  if (Array.isArray(policy.capabilities) && policy.capabilities.length > 0) {
    lines.push(`    ${muted(padRight('Abilities', 10))} ${muted(policy.capabilities.join(', '))}`);
  }
  const fallback = nextFallbackEntry(policy);
  if (fallback) {
    lines.push(
      `    ${muted(padRight('Fallback', 10))} ${fallback.backendKey} ${muted(`(${fallback.provider} → ${fallback.providerModelId}) — configured`)}`,
    );
  } else {
    lines.push(`    ${muted(padRight('Fallback', 10))} ${muted('none — single-tier route')}`);
  }
  if (policy.stagePolicies.length > 0) {
    const stageSummary = policy.stagePolicies
      .map((s) => `${s.stage}: ${s.primaryBackendKey}${s.orderedBackends.length > 1 ? muted(` (+${s.orderedBackends.length - 1} fallback)`) : ''}`)
      .join('  ');
    lines.push(`    ${muted(padRight('Stages', 10))} ${muted(stageSummary)}`);
  }
  if (availability) {
    for (const line of renderModelAvailability(availability)) lines.push(line);
  }
  lines.push(muted('\n  More: /model why · /model health · /model clear'));
  return lines.join('\n');
}

/** Compact backend/price table shared with `/policy` and `babel models list`. */
export function renderAvailableModelsTable(
  models: { key: string; entry: ModelPolicyModelEntry }[] = getAvailableModels(),
): string {
  const lines: string[] = [];
  lines.push(`  ${accentBright('Available Models:')}`);
  for (const m of models) {
    const cost = m.entry.estimated_cost_per_1m_output;
    // Unknown cost stays unknown — only an explicit 0 renders as $0/M.
    const costText = cost === undefined ? 'n/a' : `$${cost}/M`;
    lines.push(
      `    ${accentBright(padRight(m.key, 12))} ${muted(padRight(costText, 10))}${m.entry.selection_reason ? `  ${muted(m.entry.selection_reason)}` : ''}`,
    );
  }
  return lines.join('\n');
}

// ═══ Effective model availability (read-only canonical projection) ═══════════
//
// This surface answers "what will actually serve this selector?" by mapping the
// shared route-selection gate (`resolveModelSelection`), the catalog projection
// (`CatalogSnapshot`) and the canonical price quotes (`resolvePriceQuote`) into
// one read-only view. It never stores a second registry, never mutates state and
// never mints an admission decision: admitted/blocked is copied verbatim from
// the shared gate. Rendering is non-authoritative and prints no credential
// values or private endpoints.

/** How reachable a model's transport actually is for this build. */
export type ModelTransportState =
  | 'connected'
  | 'listed_not_connected'
  | 'not_implemented'
  | 'unknown'

/** Evidence strength for one capability, ordered by source not confidence. */
export type ModelCapabilityEvidenceLevel =
  | 'declared'
  | 'api_advertised'
  | 'request_accepted'
  | 'behavioral'
  | 'unknown'

/** One capability with an explicit support/evidence split. */
export interface ModelCapabilityAvailability {
  capability: string
  support: 'supported' | 'unsupported' | 'conditional' | 'conflicting' | 'unknown'
  evidenceLevel: ModelCapabilityEvidenceLevel
  /** True when the strongest evidence is a vendor claim, not observed behavior. */
  advertisedOnly: boolean
}

/** Catalog observation freshness, never conflated with routing health. */
export interface ModelFreshnessView {
  status: 'fresh' | 'stale' | 'unknown'
  observedAt: string | null
  ageDays: number | null
  maxAgeDays: number
  reason: string | null
}

/** One limit axis with its owning scope, never blended into a single maximum. */
export interface ModelLimitAvailability {
  contextTokens: number | null
  maxOutputTokens: number | null
  source: string | null
}

/** One selectable route/catalog model in the shared picker projection. */
export interface ModelCandidateView {
  routeId: string | null
  ref: ModelRef
  providerQualifiedId: string
  /** Copied from the shared admission gate; never minted by the renderer. */
  usable: boolean
  admissionCode: string
  reason: string | null
  catalogListed: boolean
  credentialRequired: boolean
  credentialPresent: boolean
}

/** A vendor-named alias and the provider it actually resolves to. */
export interface ModelVendorAliasView {
  alias: string
  resolvedProviderId: string
  /** The vendor the alias name implies, when it names one. */
  impliedVendor: ProviderId | null
  /** True when the alias name implies one vendor but resolves to another. */
  mismatchedVendor: boolean
  note: string | null
}

/**
 * Read-only presentation projection of one model-selection result.
 *
 * Every field is derived from existing canonical types
 * (`ModelRef`, `CatalogSnapshot`, `resolveModelSelection`, `resolvePriceQuote`).
 * There is deliberately no stored second registry and no UI-owned model list.
 */
export interface ModelAvailabilityView {
  schemaVersion: 1
  requested: string
  status: 'resolved' | 'fallback' | 'blocked' | 'unknown'
  routeId: string | null
  ref: ModelRef | null
  providerQualifiedId: string | null
  canonicalModelId: string | null
  providerKnown: boolean
  purpose: ProviderPurpose | null
  protocol: string | null
  transport: ModelTransportState
  aliasUsed: boolean
  vendorAlias: ModelVendorAliasView | null
  vendorAliases: ModelVendorAliasView[]
  admission: { admitted: boolean; code: string; reason: string }
  blockedReason: string | null
  fallbackReason: string | null
  preview: boolean
  freshness: ModelFreshnessView
  modelLimits: ModelLimitAvailability
  providerLimits: ModelLimitAvailability
  requestOutputCap: number | null
  effectiveOutputLimit: number | null
  outputCapExceeded: boolean
  capabilities: ModelCapabilityAvailability[]
  /** Catalog protocol qualification for the selected profile, when profiled. */
  qualification: string | null
  price: PriceQuoteResult
  candidates: ModelCandidateView[]
}

/** Inputs for {@link buildModelAvailabilityView}. */
export interface ModelAvailabilityViewInput {
  requested: string
  mode: ExecutionMode
  routes: readonly ConfiguredRoute[]
  aliases?: readonly ModelAliasDeclaration[]
  catalog?: CatalogSnapshot
  authorizations?: readonly RouteAuthorizationEntry[]
  /** Requested output cap to compare against the effective model/provider limit. */
  requestOutputCap?: number | null
  now?: Date
  maxCatalogAgeDays?: number
  env?: NodeJS.ProcessEnv
}

const DEFAULT_MAX_CATALOG_AGE_DAYS = 30

const VENDOR_ALIAS_PROVIDERS: Readonly<Record<string, ProviderId>> = {
  claude: 'anthropic',
  anthropic: 'anthropic',
  codex: 'openai',
  gpt: 'openai',
  openai: 'openai',
  gemini: 'gemini',
  google: 'gemini',
}

const VENDOR_LABELS: Readonly<Record<ProviderId, string>> = {
  deepinfra: 'DeepInfra',
  deepseek: 'DeepSeek',
  opencode: 'OpenCode',
  'opencode-go': 'OpenCode',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  groq: 'Groq',
  ollama: 'Ollama',
}

function impliedVendorForAlias(alias: string): ProviderId | null {
  return VENDOR_ALIAS_PROVIDERS[alias.trim().toLowerCase()] ?? null
}

function formatProviderQualified(ref: ModelRef | null): string | null {
  return ref ? `${ref.provider}:${ref.modelId}` : null
}

/** Narrow the discriminated selection result to an admitted success. */
function isSelectionSuccess(selection: ModelSelectionResult): selection is ModelSelectionSuccess {
  return selection.status === 'resolved' || selection.status === 'fallback'
}

/** Evaluate the shared admission gate defensively; absence is an explicit null. */
function safeAdmission(
  input: ModelAvailabilityViewInput,
  route: ConfiguredRoute,
): RouteAdmissionDecision | null {
  try {
    return evaluateRouteAdmission(input, route)
  } catch {
    return null
  }
}

function aliasTargetRef(
  target: ModelRef | string,
  routes: readonly ConfiguredRoute[],
): ModelRef | null {
  if (typeof target !== 'string') return target
  const byRouteId = routes.find((route) => route.routeId === target)
  if (byRouteId) return byRouteId.ref
  const byModelId = routes.find((route) => route.ref.modelId === target)
  return byModelId?.ref ?? null
}

function buildVendorAliasView(
  declaration: ModelAliasDeclaration,
  routes: readonly ConfiguredRoute[],
): ModelVendorAliasView | null {
  const targetRef = aliasTargetRef(declaration.target, routes)
  if (!targetRef) return null
  const impliedVendor = impliedVendorForAlias(declaration.alias)
  const mismatchedVendor = impliedVendor !== null && targetRef.provider !== impliedVendor
  return {
    alias: declaration.alias,
    resolvedProviderId: targetRef.provider,
    impliedVendor,
    mismatchedVendor,
    note: mismatchedVendor && impliedVendor
      ? `compatibility alias — resolves to ${targetRef.provider}:${targetRef.modelId}, not a native ${VENDOR_LABELS[impliedVendor]} model`
      : null,
  }
}

function summarizeFreshness(
  catalog: CatalogSnapshot | undefined,
  now: Date,
  maxAgeDays: number,
): ModelFreshnessView {
  if (!catalog) {
    return { status: 'unknown', observedAt: null, ageDays: null, maxAgeDays, reason: 'no catalog snapshot is available' }
  }
  const observedAt = catalog.observedAt
  const parsed = Date.parse(observedAt)
  if (!Number.isFinite(parsed)) {
    return { status: 'unknown', observedAt, ageDays: null, maxAgeDays, reason: `catalog observedAt "${observedAt}" is not a valid date` }
  }
  const ageDays = Math.max(0, Math.floor((now.getTime() - parsed) / 86_400_000))
  const failedSource = catalog.sourceResults.find((result) => result.status !== 'ok')
  if (failedSource) {
    return {
      status: 'stale',
      observedAt,
      ageDays,
      maxAgeDays,
      reason: `catalog source '${failedSource.sourceId}' read status is ${failedSource.status}`,
    }
  }
  const partialSource = catalog.sourceResults.find((result) => result.completeness === 'partial')
  if (partialSource) {
    return {
      status: 'stale',
      observedAt,
      ageDays,
      maxAgeDays,
      reason: `catalog source '${partialSource.sourceId}' read was partial`,
    }
  }
  if (ageDays > maxAgeDays) {
    return {
      status: 'stale',
      observedAt,
      ageDays,
      maxAgeDays,
      reason: `catalog observation is ${ageDays} days old (window ${maxAgeDays})`,
    }
  }
  return { status: 'fresh', observedAt, ageDays, maxAgeDays, reason: null }
}

function capabilityRow(
  capability: string,
  observation: CapabilityObservation | undefined,
): ModelCapabilityAvailability | null {
  if (!observation) return null
  const evidenceLevel = (observation.evidenceLevel ?? 'unknown') as ModelCapabilityEvidenceLevel
  return {
    capability,
    support: observation.support ?? 'unknown',
    evidenceLevel,
    advertisedOnly: evidenceLevel === 'declared' || evidenceLevel === 'api_advertised',
  }
}

function summarizeCapabilities(
  profile: ProviderModelProfile | null,
): { capabilities: ModelCapabilityAvailability[]; qualification: string | null } {
  const protocol: ProtocolProfile | null = profile?.protocolProfiles[0] ?? null
  if (!protocol) return { capabilities: [], qualification: null }
  const rows = [
    capabilityRow('tools.basic', protocol.tools.basicTools),
    capabilityRow('tools.parallel', protocol.tools.parallelTools),
    capabilityRow('tools.choice_required', protocol.tools.toolChoiceRequired),
    capabilityRow('structuredOutput.json_object', protocol.structuredOutput.jsonObjectMode),
    capabilityRow('structuredOutput.json_schema', protocol.structuredOutput.jsonSchemaMode),
    capabilityRow('reasoning', protocol.reasoning.enabled),
    capabilityRow('streaming', protocol.streaming),
  ].filter((row): row is ModelCapabilityAvailability => row !== null)
  return { capabilities: rows, qualification: protocol.qualificationStatus }
}

function limitView(
  limit: { contextTokens?: number; maxOutputTokens?: number } | undefined,
  source: string,
): ModelLimitAvailability {
  return {
    contextTokens: limit?.contextTokens ?? null,
    maxOutputTokens: limit?.maxOutputTokens ?? null,
    source,
  }
}

function credentialFacts(
  provider: ProviderId,
  env: NodeJS.ProcessEnv,
): { credentialRequired: boolean; credentialPresent: boolean } {
  try {
    const status = getProviderCredentialStatus(provider, env)
    return { credentialRequired: status.required, credentialPresent: status.configured }
  } catch {
    return { credentialRequired: false, credentialPresent: false }
  }
}

function resolvePriceFor(
  ref: ModelRef | null,
  catalog: CatalogSnapshot | undefined,
): PriceQuoteResult {
  if (!ref) {
    return { status: 'unknown', quote: null, quoteRevision: null, perToken: null, reason: 'no provider/model identity was resolved' }
  }
  if (catalog) {
    const fromCatalog = resolvePriceQuote({ provider: ref.provider, modelId: ref.modelId, catalog })
    if (fromCatalog.status === 'exact') return fromCatalog
  }
  return resolvePriceQuote({ provider: ref.provider, modelId: ref.modelId })
}

function buildCandidates(input: ModelAvailabilityViewInput, catalogListedKeys: Set<string>): ModelCandidateView[] {
  const env = input.env ?? process.env
  const rows: ModelCandidateView[] = []
  const seen = new Set<string>()
  for (const route of input.routes) {
    const key = modelRefKey(route.ref)
    seen.add(key)
    const decision = safeAdmission(input, route)
    const admitted = decision?.admitted === true
    const code = decision?.code ?? 'unknown'
    const reason = admitted ? null : decision?.reason ?? 'route admission could not be evaluated'
    const credential = isProviderId(route.ref.provider)
      ? credentialFacts(route.ref.provider, env)
      : { credentialRequired: false, credentialPresent: false }
    rows.push({
      routeId: route.routeId,
      ref: route.ref,
      providerQualifiedId: `${route.ref.provider}:${route.ref.modelId}`,
      usable: admitted && (!credential.credentialRequired || credential.credentialPresent),
      admissionCode: code,
      reason,
      catalogListed: catalogListedKeys.has(key),
      credentialRequired: credential.credentialRequired,
      credentialPresent: credential.credentialPresent,
    })
  }
  for (const profile of input.catalog?.providerModels ?? []) {
    const ref: ModelRef = { provider: profile.provider, modelId: profile.providerModelId }
    const key = modelRefKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    const credential = credentialFacts(profile.provider, env)
    rows.push({
      routeId: null,
      ref,
      providerQualifiedId: `${ref.provider}:${ref.modelId}`,
      usable: false,
      admissionCode: 'no_eligible_route',
      reason: 'listed in the catalog but no configured route connects it',
      catalogListed: true,
      credentialRequired: credential.credentialRequired,
      credentialPresent: credential.credentialPresent,
    })
  }
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (Number(b.row.usable) - Number(a.row.usable)) || (a.index - b.index))
    .map((entry) => entry.row)
}

/**
 * Map existing canonical result types into one read-only availability view.
 *
 * The function is pure: it calls the shared selection/admission/quote
 * projections and copies their results without adding routing authority. It
 * never invents an admitted route, a price or a capability claim.
 */
export function buildModelAvailabilityView(input: ModelAvailabilityViewInput): ModelAvailabilityView {
  const now = input.now ?? new Date()
  const maxAgeDays = input.maxCatalogAgeDays ?? DEFAULT_MAX_CATALOG_AGE_DAYS
  const env = input.env ?? process.env
  const selection = resolveModelSelection({
    mode: input.mode,
    requested: input.requested,
    routes: input.routes,
    ...(input.aliases ? { aliases: input.aliases } : {}),
    ...(input.catalog ? { catalog: input.catalog } : {}),
    ...(input.authorizations ? { authorizations: input.authorizations } : {}),
  })
  const ref = selection.ref
  const profile = ref && input.catalog ? findModelProfile(input.catalog, ref) ?? null : null
  const labModel: LabModelSpec | null = profile && input.catalog
    ? input.catalog.labModels.find((model) => model.canonicalModelId === profile.canonicalModelId) ?? null
    : null
  const providerKnown = ref ? isProviderId(ref.provider) : false
  const spec = ref && providerKnown ? getProviderSpec(ref.provider) : null
  const route = selection.routeId
    ? input.routes.find((candidate) => candidate.routeId === selection.routeId) ?? null
    : null
  const catalogListedKeys = new Set(
    (input.catalog?.providerModels ?? []).map((entry) =>
      modelRefKey({ provider: entry.provider, modelId: entry.providerModelId }),
    ),
  )
  const implemented = spec?.authorityConformance === 'certified'
  let transport: ModelTransportState = 'unknown'
  if (spec && !implemented) {
    transport = 'not_implemented'
  } else if (implemented && route) {
    transport = 'connected'
  } else if (implemented && profile) {
    transport = 'listed_not_connected'
  }

  const gate = route ? safeAdmission(input, route) : null
  const admission = isSelectionSuccess(selection)
    ? { admitted: selection.admission.admitted, code: selection.admission.code as string, reason: selection.admission.reason }
    : {
        admitted: false,
        code: (gate?.code ?? selection.code) as string,
        reason: gate?.reason || selection.reason,
      }

  const aliases = input.aliases ?? []
  const vendorAliases = aliases
    .map((declaration) => buildVendorAliasView(declaration, input.routes))
    .filter((row): row is ModelVendorAliasView => row !== null)
  const aliasId = selection.aliasId
  const vendorAlias = selection.aliasUsed && aliasId
    ? vendorAliases.find((row) => row.alias.toLowerCase() === aliasId.toLowerCase()) ?? null
    : null

  const { capabilities, qualification } = summarizeCapabilities(profile)
  const modelLimits = limitView(labModel?.declaredLimits, 'lab_model')
  const providerLimits = limitView(profile?.providerLimits, 'provider')
  const limitValues = [modelLimits.maxOutputTokens, providerLimits.maxOutputTokens]
    .filter((value): value is number => typeof value === 'number')
  const effectiveOutputLimit = limitValues.length > 0 ? Math.min(...limitValues) : null
  const requestOutputCap = input.requestOutputCap ?? null
  const modelId = ref?.modelId ?? ''

  return {
    schemaVersion: 1,
    requested: input.requested,
    status: selection.status,
    routeId: selection.routeId,
    ref,
    providerQualifiedId: formatProviderQualified(ref),
    canonicalModelId: profile?.canonicalModelId ?? null,
    providerKnown,
    purpose: spec?.purpose ?? null,
    protocol: route?.protocol ?? spec?.protocol ?? null,
    transport,
    aliasUsed: selection.aliasUsed,
    vendorAlias,
    vendorAliases,
    admission,
    blockedReason: isSelectionSuccess(selection) ? null : selection.reason,
    fallbackReason: selection.status === 'fallback' ? selection.fallbackReason : null,
    preview: /preview|:free|\blatest\b/i.test(modelId),
    freshness: summarizeFreshness(input.catalog, now, maxAgeDays),
    modelLimits,
    providerLimits,
    requestOutputCap,
    effectiveOutputLimit,
    outputCapExceeded:
      requestOutputCap !== null && effectiveOutputLimit !== null && requestOutputCap > effectiveOutputLimit,
    capabilities,
    qualification,
    price: resolvePriceFor(ref, input.catalog),
    candidates: buildCandidates(input, catalogListedKeys),
  }
}

function formatUsdPerMillion(perToken: number | null): string {
  if (perToken === null) return 'unknown'
  return `$${(perToken * 1_000_000).toFixed(4)}/M`
}

function describeTransport(transport: ModelTransportState): string {
  switch (transport) {
    case 'connected':
      return 'connected — a configured route and an implemented transport exist'
    case 'listed_not_connected':
      return 'listed in the catalog but no configured route connects it'
    case 'not_implemented':
      return 'transport not implemented — provider is registered but not authority-certified for a live lane'
    default:
      return 'unknown — no provider/model transport identity'
  }
}

/**
 * Render the effective availability rows appended to `/model show`.
 *
 * Non-authoritative presentation only: it prints no credential values and no
 * private endpoints, and the admitted/blocked state is the shared gate's.
 */
export function renderModelAvailability(view: ModelAvailabilityView): string[] {
  const lines: string[] = []
  lines.push(`    ${muted(padRight('Availability', 14))} ${view.status === 'blocked' || view.status === 'unknown' ? warning(view.status) : accentBright(view.status)}`);
  const admissionText = view.admission.admitted
    ? 'admitted'
    : `blocked (${view.admission.code}): ${view.admission.reason || 'no reason recorded'}`;
  lines.push(`    ${muted(padRight('Admission', 14))} ${view.admission.admitted ? admissionText : warning(admissionText)}`);
  if (view.blockedReason) {
    lines.push(`    ${muted(padRight('Blocked', 14))} ${warning(view.blockedReason)}`);
  }
  if (view.fallbackReason) {
    lines.push(`    ${muted(padRight('Fallback why', 14))} ${muted(view.fallbackReason)}`);
  }
  lines.push(`    ${muted(padRight('Transport', 14))} ${muted(describeTransport(view.transport))}`);
  if (view.providerQualifiedId) {
    lines.push(`    ${muted(padRight('Effective', 14))} ${accentBright(view.providerQualifiedId)}${view.routeId ? muted(` (route ${view.routeId})`) : ''}`);
  }
  lines.push(`    ${muted(padRight('Purpose', 14))} ${muted(view.purpose ?? 'unknown')}`);
  const freshnessText = view.freshness.status === 'fresh'
    ? `fresh${view.freshness.observedAt ? ` (observed ${view.freshness.observedAt})` : ''}`
    : `${view.freshness.status} — ${view.freshness.reason ?? 'reason not recorded'}`;
  lines.push(`    ${muted(padRight('Catalog', 14))} ${view.freshness.status === 'fresh' ? freshnessText : warning(freshnessText)}`);
  const limitText = `model context ${formatContextTokens(view.modelLimits.contextTokens ?? undefined)} · output ${formatContextTokens(view.modelLimits.maxOutputTokens ?? undefined)}`
    + (view.requestOutputCap !== null ? ` · request cap ${view.requestOutputCap}${view.outputCapExceeded ? ' (exceeds effective output limit)' : ''}` : '');
  lines.push(`    ${muted(padRight('Limits', 14))} ${muted(limitText)}`);
  if (view.capabilities.length > 0) {
    const capabilityText = view.capabilities
      .map((row) => `${row.capability}:${row.support}/${row.evidenceLevel}${row.advertisedOnly ? ' (advertised only)' : ''}`)
      .join('  ');
    const qualificationSuffix = view.qualification ? ` · protocol qualification: ${view.qualification}` : '';
    lines.push(`    ${muted(padRight('Capabilities', 14))} ${muted(`${capabilityText}${qualificationSuffix}`)}`);
  }
  if (view.price.status === 'exact' && view.price.quote && view.price.perToken) {
    const quote = view.price.quote;
    lines.push(
      `    ${muted(padRight('Price', 14))} ${accentBright('exact')} ${muted(`${formatUsdPerMillion(view.price.perToken.input)} in · ${formatUsdPerMillion(view.price.perToken.output)} out · source ${quote.sourceUrl} · verified ${quote.verifiedAt} · revision ${quote.quoteRevision.slice(0, 12)}`)}`,
    );
  } else {
    lines.push(`    ${muted(padRight('Price', 14))} ${muted(`unknown — ${view.price.reason ?? 'no applicable quote'}`)}`);
  }
  if (view.vendorAlias?.note) {
    lines.push(`    ${muted(padRight('Alias', 14))} ${muted(`'${view.vendorAlias.alias}' → ${view.vendorAlias.resolvedProviderId} — ${view.vendorAlias.note}`)}`);
  }
  if (view.preview) {
    lines.push(`    ${muted(padRight('Preview', 14))} ${muted('preview model — lifecycle and capability facts are provisional')}`);
  }
  return lines
}

const MODEL_PICKER_MARKER = 'usable first — unavailable models are still listed'

/**
 * Render the shared model picker: admitted routes first, unavailable models
 * still visible. This is the only model list the interactive picker shows; it
 * is projected from the same {@link ModelAvailabilityView} as `/model show`.
 */
export function renderModelPicker(view: ModelAvailabilityView): string {
  const lines: string[] = []
  lines.push(`  ${accentBright('Available Models')} ${muted(`(${MODEL_PICKER_MARKER})`)}`)
  for (const candidate of view.candidates) {
    const credential = candidate.credentialRequired
      ? candidate.credentialPresent
        ? muted(' · credential present (presence only)')
        : warning(' · credential missing')
      : muted(' · no credential required')
    const credentialReady = !candidate.credentialRequired || candidate.credentialPresent
    const state = candidate.usable
      ? accentBright('usable')
      : warning(
          candidate.admissionCode === 'admitted' && !credentialReady
            ? 'unavailable (credential not configured)'
            : candidate.reason
              ? `unavailable (${candidate.admissionCode}): ${candidate.reason}`
              : `unavailable (${candidate.admissionCode})`,
        )
    const label = candidate.routeId ?? '(catalog only)'
    lines.push(`    ${accentBright(padRight(label, 25))} ${muted(candidate.providerQualifiedId)}  ${state}${credential}`)
  }
  const aliasLines = view.vendorAliases.filter((row) => row.mismatchedVendor)
  if (aliasLines.length > 0) {
    lines.push(`  ${accentBright('Compatibility Aliases')} ${muted('(deprecated vendor names — not native vendor models)')}`)
    for (const row of aliasLines) {
      lines.push(`    ${muted(padRight(row.alias, 25))} ${muted(`→ ${row.resolvedProviderId} — ${row.note ?? 'compatibility alias'}`)}`)
    }
  }
  return lines.join('\n')
}

// ─── Policy-scoped projection ─────────────────────────────────────────────────

/**
 * Materialize the read-only route/alias projection from the validated model
 * policy. This is a projection, never a registry: it reads the same decision
 * graph the runtime uses and adds no authority.
 */
export function projectConfiguredRoutes(config: ValidatedModelPolicy): {
  routes: ConfiguredRoute[]
  aliases: ModelAliasDeclaration[]
} {
  const routes: ConfiguredRoute[] = []
  for (const [routeId, entry] of Object.entries(config.models ?? {})) {
    if (!isProviderId(entry.provider)) continue
    routes.push({
      routeId,
      ref: { provider: entry.provider, modelId: entry.model_id },
      protocol: getProviderSpec(entry.provider).protocol,
      enabled: entry.enabled !== false,
      requiredOperation: 'structured',
    })
  }
  const aliases: ModelAliasDeclaration[] = Object.entries(config.vendor_aliases ?? {}).map(
    ([alias, entry]) => ({ alias, target: entry.maps_to }),
  )
  return { routes, aliases }
}

function loadCatalogSnapshotOrUndefined(): CatalogSnapshot | undefined {
  try {
    return loadLiteCatalogSnapshot()
  } catch {
    return undefined
  }
}

/** Options for the policy-scoped availability projection. */
export interface PolicyModelAvailabilityOptions {
  requested: string
  mode?: ExecutionMode
  env?: NodeJS.ProcessEnv
  catalog?: CatalogSnapshot
  now?: Date
  requestOutputCap?: number | null
  babelRoot?: string
}

/**
 * Build the effective availability view from the canonical policy and the
 * committed offline catalog snapshot. No network access and no stored registry;
 * an unreadable policy or catalog degrades to an explicit unknown/absent view.
 */
export function resolvePolicyModelAvailability(
  options: PolicyModelAvailabilityOptions,
): ModelAvailabilityView | null {
  let config: ValidatedModelPolicy
  try {
    config = loadModelPolicyConfig(options.babelRoot).config
  } catch {
    return null
  }
  const { routes, aliases } = projectConfiguredRoutes(config)
  const catalog = options.catalog ?? loadCatalogSnapshotOrUndefined()
  return buildModelAvailabilityView({
    requested: options.requested,
    mode: options.mode ?? 'production_resilient',
    routes,
    aliases,
    ...(catalog ? { catalog } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.requestOutputCap !== undefined ? { requestOutputCap: options.requestOutputCap } : {}),
  })
}
