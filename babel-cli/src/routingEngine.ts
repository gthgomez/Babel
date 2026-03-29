/**
 * routingEngine.ts — Dynamic Routing Engine v1
 *
 * Reads recent `05_waterfall_telemetry.json` files written by the evidence
 * bundle and selects the best starting tier for each stage before the normal
 * cascade begins.
 *
 * Design goals:
 *   - Zero changes to existing runners or prompt contracts
 *   - Uses only data Babel already writes today
 *   - Safe fallback: thin/missing telemetry keeps the original waterfall order
 *   - Simple, stable scoring: win rate, retry penalty, fallback-history penalty
 *
 * Scoring formula (per tier):
 *   base          = winRate × 100  (or 35 if no observations yet)
 *   + priorBias   = (tierCount − originalIndex) × 4  (preserves order when data is thin)
 *   + sampleBonus = min(observed, 10)
 *   − retryPenalty      = avgAttempts × 10
 *   − fallbackPenalty   = avgFallbacksBeforeWin × 5
 *   − skippedPenalty    = skippedFailureCount × 4
 *
 * Environment variables:
 *   BABEL_DYNAMIC_ROUTING             — Set to "true" to enable globally.
 *   BABEL_DYNAMIC_ROUTING_MAX_RUNS    — Recent runs to scan.       Default: 50.
 *   BABEL_DYNAMIC_ROUTING_MIN_SAMPLES — Min hits before trusting score. Default: 3.
 *   BABEL_RUNS_DIR                    — Override runs directory (shared with pipeline.ts).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve }                 from 'node:path';
import { fileURLToPath }                          from 'node:url';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Mirrors `PipelineStage` in execute.ts — kept separate to avoid circular imports. */
export type RoutingStage = 'orchestrator' | 'planning' | 'qa' | 'executor';

interface WaterfallTelemetryEntry {
  stage:          string;
  tier_succeeded: string;
  tier_index:     number;
  attempts:       number;
  tiers_skipped:  string[];
  cascade_reason: string;
  ts:             string;
}

/** Per-tier scoring breakdown. */
export interface TierScore {
  name:                 string;
  originalIndex:        number;
  /** Total events where this tier was involved (wins + skipped failures). */
  observed:             number;
  wins:                 number;
  skippedFailures:      number;
  winRate:              number;
  avgAttempts:          number;
  avgFallbacksBeforeWin: number;
  score:                number;
}

/** Full routing decision returned to execute.ts. */
export interface RoutingDecision {
  stage:                RoutingStage;
  selectedIndex:        number;
  selectedName:         string;
  telemetryRunsScanned: number;
  scoredTiers:          TierScore[];
  reason:               string;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const __filename      = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename);

// Base path formula: dist/routingEngine.js → up two levels → Babel/ → + runs
// (same as pipeline.ts). The full path is resolved lazily so that tests can
// override BABEL_RUNS_DIR with withPatchedEnv after module load.
const BABEL_ROOT_PATH = resolve(__dirname_local, '../..');

function getDefaultRunsDir(): string {
  return process.env['BABEL_RUNS_DIR'] ?? join(BABEL_ROOT_PATH, 'runs');
}

const MAX_RUNS    = Math.max(1, Number(process.env['BABEL_DYNAMIC_ROUTING_MAX_RUNS']    ?? '50') || 50);
const MIN_SAMPLES = Math.max(1, Number(process.env['BABEL_DYNAMIC_ROUTING_MIN_SAMPLES'] ?? '3')  || 3);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeMean(values: number[], fallback: number): number {
  return values.length === 0
    ? fallback
    : values.reduce((acc, v) => acc + v, 0) / values.length;
}

function isDynamicRoutingEnabled(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  return process.env['BABEL_DYNAMIC_ROUTING'] === 'true';
}

// ─── Telemetry loading ────────────────────────────────────────────────────────

function listRecentRunDirs(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort((a, b) => b.localeCompare(a))   // lexicographic descending → newest first
    .slice(0, MAX_RUNS)
    .map(name => join(runsDir, name));
}

function loadStageTelemetry(
  stage:   RoutingStage,
  runsDir: string,
): { entries: WaterfallTelemetryEntry[]; runsScanned: number } {
  const runDirs = listRecentRunDirs(runsDir);
  const entries: WaterfallTelemetryEntry[] = [];

  for (const runDir of runDirs) {
    const telemetryPath = join(runDir, '05_waterfall_telemetry.json');
    if (!existsSync(telemetryPath)) continue;

    try {
      const raw = JSON.parse(readFileSync(telemetryPath, 'utf-8')) as unknown;
      if (!Array.isArray(raw)) continue;

      for (const item of raw) {
        if (
          item !== null &&
          typeof item === 'object' &&
          typeof (item as Record<string, unknown>)['stage'] === 'string' &&
          (item as Record<string, unknown>)['stage'] === stage
        ) {
          entries.push(item as WaterfallTelemetryEntry);
        }
      }
    } catch {
      // Corrupt or partial file — skip silently.
      continue;
    }
  }

  return { entries, runsScanned: runDirs.length };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreTier(
  name:          string,
  originalIndex: number,
  stageEntries:  WaterfallTelemetryEntry[],
  tierCount:     number,
): TierScore {
  const wins            = stageEntries.filter(e => e.tier_succeeded === name);
  const skippedFailures = stageEntries.filter(e => e.tiers_skipped.includes(name));

  const observed = wins.length + skippedFailures.length;
  const winRate  = observed > 0 ? wins.length / observed : 0;

  const avgAttempts           = safeMean(wins.map(e => e.attempts), 2);
  const avgFallbacksBeforeWin = safeMean(wins.map(e => e.tiers_skipped.length), 0);

  // priorBias: higher index = newer in original order = lower bias.
  // Ensures original ordering survives when telemetry data is thin.
  const priorBias   = (tierCount - originalIndex) * 4;
  const sampleBonus = Math.min(observed, 10);

  const score =
    (observed > 0 ? winRate * 100 : 35) +
    priorBias +
    sampleBonus -
    avgAttempts          * 10 -
    avgFallbacksBeforeWin * 5 -
    skippedFailures.length * 4;

  return {
    name,
    originalIndex,
    observed,
    wins:                 wins.length,
    skippedFailures:      skippedFailures.length,
    winRate,
    avgAttempts,
    avgFallbacksBeforeWin,
    score,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Selects the best starting tier for the given stage using recent telemetry.
 *
 * Returns `null` (keep original order) when:
 *   - Dynamic routing is disabled and `options.enabled` is not explicitly `true`
 *   - The waterfall has only one tier
 *   - Fewer than `MIN_SAMPLES` stage-specific telemetry entries exist
 *
 * The caller is responsible for reordering the waterfall using `selectedIndex`
 * (see `reorderWaterfallByStartIndex`).
 */
export function selectBestTierForStage(
  stage:          RoutingStage,
  waterfallNames: string[],
  options?: { enabled?: boolean; runsDir?: string },
): RoutingDecision | null {
  if (!isDynamicRoutingEnabled(options?.enabled)) return null;
  if (waterfallNames.length <= 1) return null;

  const runsDir = options?.runsDir ?? getDefaultRunsDir();
  const { entries, runsScanned } = loadStageTelemetry(stage, runsDir);

  if (entries.length < MIN_SAMPLES) return null;

  const scoredTiers = waterfallNames
    .map((name, index) => scoreTier(name, index, entries, waterfallNames.length))
    .sort((a, b) => b.score - a.score);

  const winner = scoredTiers[0]!;

  return {
    stage,
    selectedIndex:        winner.originalIndex,
    selectedName:         winner.name,
    telemetryRunsScanned: runsScanned,
    scoredTiers,
    reason:
      `Dynamic Routing v1 — scored ${entries.length} entries across ${runsScanned} runs.`,
  };
}

/**
 * Reorders `items` so the element at `startIndex` is moved to position 0,
 * with all other elements following in their original relative order.
 *
 * Returns the original array unchanged if:
 *   - `startIndex` is `undefined`, `0`, negative, or ≥ `items.length`
 */
export function reorderWaterfallByStartIndex<T>(items: T[], startIndex: number | undefined): T[] {
  if (startIndex === undefined || startIndex <= 0 || startIndex >= items.length) return items;
  const moved = items[startIndex]!;
  return [moved, ...items.slice(0, startIndex), ...items.slice(startIndex + 1)];
}
