// ─── Model Detail — operator surface for model identity, routing, and health ──
// Backs `/model show|why|health` in the REPL and `babel models list` in the CLI.
// Presentation only: every fact comes from the canonical model policy, the
// credential hub, and the latest run bundle. No network access and no
// second source of truth — this module renders what modelPolicy.ts resolves.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveChatModelPolicy } from '../../agent/chatModelPolicy.js';
import {
  getAvailableModels,
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

/** Structural subset of a `WaterfallOutcome` record in `05_waterfall_telemetry.json`. */
interface WaterfallTelemetryEntry {
  stage?: string;
  tier_succeeded?: string;
  tier_index?: number;
  tiers_skipped?: string[];
  cascade_reason?: string;
}

/** Structural subset of the serialized RoutingDecision in `debug_dynamic_routing_*.json`. */
interface DynamicRoutingDebugEntry {
  stage?: string;
  selectedName?: string;
  selectedIndex?: number;
  telemetryRunsScanned?: number;
  reason?: string;
}

export interface LastRouteFacts {
  runDir: string;
  lastWaterfall: WaterfallTelemetryEntry | null;
  dynamicRouting: DynamicRoutingDebugEntry | null;
}

let autoSnapshotCache: ModelSnapshot | null | undefined;

/**
 * Resolve the model snapshot for display: the session override when set,
 * otherwise the policy default (offline-aware, live lane by default).
 * Returns null when the policy cannot be resolved at all.
 */
export function resolveModelSnapshot(sessionModel?: string): ModelSnapshot | null {
  if (sessionModel) {
    try {
      const { policy, offline } = resolveChatModelPolicy({ model: sessionModel });
      return { source: 'session', offline, policy };
    } catch {
      return null;
    }
  }
  if (autoSnapshotCache !== undefined) return autoSnapshotCache;
  try {
    const { policy, offline } = resolveChatModelPolicy({});
    autoSnapshotCache = { source: 'auto', offline, policy };
  } catch {
    autoSnapshotCache = null;
  }
  return autoSnapshotCache;
}

/** Invalidate the cached policy-default snapshot (call after /model set|clear). */
export function resetModelSnapshotCache(): void {
  autoSnapshotCache = undefined;
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
  const index = policy.waterfall.findIndex((e) => e.backendKey === policy.resolvedBackendKey);
  if (index >= 0 && index + 1 < policy.waterfall.length) return policy.waterfall[index + 1]!;
  if (index === -1 && policy.waterfall.length > 0) return policy.waterfall[0]!;
  return null;
}

function formatEntryMetadata(entry: ModelPolicyModelEntry | undefined): string | null {
  if (!entry) return null;
  const parts: string[] = [];
  if (entry.verified_at) parts.push(`verified ${entry.verified_at}`);
  if (entry.expires_at) parts.push(`expires ${entry.expires_at}`);
  return parts.length > 0 ? parts.join(' · ') : null;
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
  if (costParts.length > 0) {
    lines.push(`    ${muted(padRight('Cost', 10))} ${costParts.join(' · ')}`);
  }
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
      `    ${muted(padRight('Fallback', 10))} ${fallback.backendKey} ${muted(`(${fallback.provider} → ${fallback.providerModelId})`)}`,
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

/**
 * Read routing facts from the most recent run bundle (waterfall telemetry and
 * per-stage dynamic-routing decision). Returns null when no run data exists.
 */
export function readLastRouteFacts(lastRunDir?: string | null): LastRouteFacts | null {
  const runDir = lastRunDir ?? getRecentRuns(1)[0];
  if (!runDir || !fs.existsSync(runDir)) return null;
  let lastWaterfall: WaterfallTelemetryEntry | null = null;
  let dynamicRouting: DynamicRoutingDebugEntry | null = null;
  try {
    const telemetryPath = path.join(runDir, '05_waterfall_telemetry.json');
    if (fs.existsSync(telemetryPath)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(telemetryPath, 'utf-8'));
      if (Array.isArray(parsed) && parsed.length > 0) {
        lastWaterfall = parsed[parsed.length - 1] as WaterfallTelemetryEntry;
      }
    }
  } catch {
    /* telemetry is optional */
  }
  try {
    const debugFiles = fs
      .readdirSync(runDir)
      .filter((f) => f.startsWith('debug_dynamic_routing_') && f.endsWith('.json'))
      .sort();
    if (debugFiles.length > 0) {
      dynamicRouting = JSON.parse(
        fs.readFileSync(path.join(runDir, debugFiles[debugFiles.length - 1]!), 'utf-8'),
      ) as DynamicRoutingDebugEntry;
    }
  } catch {
    /* routing debug files are optional */
  }
  if (!lastWaterfall && !dynamicRouting) return null;
  return { runDir, lastWaterfall, dynamicRouting };
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
      `    ${muted(padRight('Selection', 10))} You set this model for the session ${muted('(/model clear to use the policy default)')}`,
    );
  } else {
    lines.push(
      `    ${muted(padRight('Selection', 10))} Auto — policy default for the ${snapshot.offline ? 'offline lane' : 'live lane'}`,
    );
  }
  const reason =
    policy.selectionReason ??
    policy.tierSelectionReason ??
    findPolicyEntry(policy.resolvedBackendKey)?.selection_reason;
  if (reason) {
    lines.push(`    ${muted(padRight('Reason', 10))} ${muted(reason)}`);
  }
  if (input.lastRoutingLabel) {
    lines.push(
      `    ${muted(padRight('Last turn', 10))} served by ${accentBright(input.lastRoutingLabel)}`,
    );
  }
  const facts = readLastRouteFacts(input.lastRunDir);
  if (facts?.lastWaterfall) {
    const wf = facts.lastWaterfall;
    const skipped = Array.isArray(wf.tiers_skipped) ? wf.tiers_skipped : [];
    if ((wf.tier_index ?? 0) > 0 || skipped.length > 0) {
      lines.push(
        `    ${muted(padRight('Last run', 10))} ${warning(`fallback used — succeeded on '${wf.tier_succeeded ?? 'unknown'}'`)}${skipped.length > 0 ? muted(` after ${skipped.join(', ')} (${wf.cascade_reason ?? 'reason not recorded'})`) : ''}`,
      );
    } else if (wf.tier_succeeded) {
      lines.push(
        `    ${muted(padRight('Last run', 10))} first-tier success on ${accentBright(wf.tier_succeeded)}${wf.stage ? muted(` (${wf.stage})`) : ''}`,
      );
    }
  } else {
    lines.push(`    ${muted(padRight('Last run', 10))} ${muted('no run telemetry yet')}`);
  }
  if (facts?.dynamicRouting?.selectedName) {
    const dr = facts.dynamicRouting;
    lines.push(
      `    ${muted(padRight('Routing', 10))} ${muted(`dynamic routing preferred '${dr.selectedName}'${dr.reason ? ` — ${dr.reason}` : ''}`)}`,
    );
  }
  return lines.join('\n');
}

/** Route health: credential presence, policy metadata freshness, and live-ping hint. */
export function renderModelHealth(sessionModel?: string, env: NodeJS.ProcessEnv = process.env): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${accentBright('Model Health')}`);
  const snapshot = resolveModelSnapshot(sessionModel);
  if (!snapshot) {
    lines.push(muted('    Model policy could not be resolved — run /doctor for details.'));
    return lines.join('\n');
  }
  const { policy } = snapshot;
  try {
    const cred = getProviderCredentialStatus(policy.provider as Parameters<typeof getProviderCredentialStatus>[0], env);
    if (!cred.required) {
      lines.push(
        `    ${muted(padRight('Credential', 10))} ${muted('not required for this provider')}`,
      );
    } else if (cred.configured) {
      lines.push(
        `    ${muted(padRight('Credential', 10))} ${accentBright(cred.envVar + ' set')}`,
      );
    } else {
      lines.push(
        `    ${muted(padRight('Credential', 10))} ${warning(`${cred.envVar} not set — add it to babel-cli/.env or your environment`)}`,
      );
    }
  } catch {
    /* provider registry has no spec for this id — skip the credential row */
  }
  const freshness = validateModelPolicyMetadataFreshness();
  if (freshness.status === 'pass') {
    lines.push(`    ${muted(padRight('Metadata', 10))} ${accentBright('fresh')} ${muted('— pricing/context provenance verified')}`);
  } else {
    lines.push(
      `    ${muted(padRight('Metadata', 10))} ${warning(`${freshness.issues.length} metadata issue(s)`)}`,
    );
    for (const issue of freshness.issues.slice(0, 3)) {
      lines.push(`      ${muted(`- ${issue}`)}`);
    }
  }
  const flags: string[] = [policy.enabled ? 'enabled' : warning('disabled')];
  if (policy.experimental) flags.push(muted('experimental'));
  if (policy.blockedWithoutExplicitOptIn) flags.push(muted('opt-in required'));
  lines.push(`    ${muted(padRight('Policy', 10))} ${flags.join(' · ')}`);
  const fallback = nextFallbackEntry(policy);
  lines.push(
    `    ${muted(padRight('Fallback', 10))} ${fallback ? `${fallback.backendKey} ready` : muted('none configured')}`,
  );
  lines.push(
    muted(`    Live reachability: babel models ping --i-authorize-live --model ${policy.resolvedBackendKey}`),
  );
  return lines.join('\n');
}

/** Compact backend/price table shared with `/policy` and `babel models list`. */
export function renderAvailableModelsTable(): string {
  const lines: string[] = [];
  lines.push(`  ${accentBright('Available Models:')}`);
  for (const m of getAvailableModels()) {
    lines.push(
      `    ${accentBright(padRight(m.key, 12))} ${muted(`$${padRight(String(m.entry.estimated_cost_per_1m_output ?? 0), 6)}/M`)}${m.entry.selection_reason ? `  ${muted(m.entry.selection_reason)}` : ''}`,
    );
  }
  return lines.join('\n');
}
