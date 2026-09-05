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
import { getRecentRuns } from '../utils.js';
import { accentBright, muted, padRight, warning } from '../../ui/theme.js';

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
  mtimeMs: number;
  size: number;
}

let snapshotCache: { key: SnapshotCacheKey; snapshot: ModelSnapshot | null } | null = null;

function policyFileStamp(): { mtimeMs: number; size: number } {
  try {
    const stats = fs.statSync(getPolicyPath());
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return { mtimeMs: -1, size: -1 };
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
        `    ${muted(padRight('Last run', 14))} ${warning(`fallback used — succeeded on '${wf.tier_succeeded ?? 'unknown'}'`)}${context}${skipped.length > 0 ? muted(` after ${skipped.join(', ')} (${wf.cascade_reason ?? 'reason not recorded'})`) : ''}`,
      );
    } else if (wf.tier_succeeded) {
      lines.push(
        `    ${muted(padRight('Last run', 14))} first-tier success on ${accentBright(wf.tier_succeeded)}${context}`,
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
function describeObservations(
  policy: ResolvedModelPolicy,
  facts: LastRouteFacts | null,
): { text: string; isWarning: boolean } | null {
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
      text: `success on '${lastSuccess.tier_name ?? wf.tier_succeeded ?? 'unknown'}'${context}${lastSuccess.upstream_provider ? muted(` — upstream '${lastSuccess.upstream_provider}'`) : ''}`,
      isWarning: false,
    };
  }
  if (lastFailure) {
    const detail = lastFailure.error_summary ? ` — ${lastFailure.error_summary.slice(0, 120)}` : '';
    return { text: `failure on '${lastFailure.tier_name ?? 'unknown'}'${context}${detail}`, isWarning: true };
  }
  if (wf.tier_succeeded) {
    return { text: `success on '${wf.tier_succeeded}'${context}`, isWarning: false };
  }
  if ((wf.tier_index ?? 0) > 0) {
    return { text: `fallback used${context}${wf.cascade_reason ? ` (${wf.cascade_reason})` : ''}`, isWarning: true };
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
  const observations = describeObservations(policy, facts);
  if (observations) {
    lines.push(
      `    ${muted(padRight('Observed', 14))} ${observations.isWarning ? warning(observations.text) : observations.text}${observations.isWarning ? '' : muted(' (historical)')}`,
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
    `    ${muted(padRight('Reachability', 14))} ${muted('live reachability not checked — no probe has been run')}`,
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

/** One compact screen describing the active model, route, cost, and fallback. */
export function renderModelDetail(snapshot: ModelSnapshot): string {
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
  if (policy.approximateCostPerRunUsd !== undefined) {
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
