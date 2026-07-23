/**
 * UsageCharts — Usage and token chart visualization for the `/dashboard` command.
 *
 * Provides:
 *   - **TokenUsageTracker** — persistent per-session and cumulative token usage
 *     tracking with per-model breakdown, daily history, and cost estimation.
 *   - **Horizontal bar charts** using Unicode block characters (▏▎▍▌▋▊▉█)
 *   - **Sparklines** using Unicode braille characters (⣀⣄⣤⣦⣶⣷⣿)
 *   - **Usage summary panels** (today, week, month, all-time) with cost estimates
 *   - **Per-model breakdown tables** with proportional distribution segments
 *   - **Daily history charts** combining bars + sparkline trends
 *
 * Integration point (dashboard):
 *   The `/dashboard` command in `info.ts` should eventually call
 *   `renderUsageSummary()` and `renderDailyChart()` with data from a
 *   `TokenUsageTracker` instance.
 *
 * @module usageCharts
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { dim, muted, ghost, accent, info, success, warning, error, bold, sectionLabel } from './theme.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TokenUsageRecord {
  /** Date.now() when the record was created */
  timestamp: number;
  /** Session identifier (e.g. UUID from BABEL_SESSION_ID) */
  sessionId: string;
  /** Model ID (e.g. "claude-sonnet-4-6") */
  model: string;
  /** Prompt tokens consumed */
  promptTokens: number;
  /** Completion tokens generated */
  completionTokens: number;
  /** Total tokens (prompt + completion) */
  totalTokens: number;
}

export interface UsageSummaryPeriod {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

export interface UsageSummary {
  today: UsageSummaryPeriod;
  thisWeek: UsageSummaryPeriod;
  thisMonth: UsageSummaryPeriod;
  allTime: UsageSummaryPeriod;
}

// ── Pricing model ──────────────────────────────────────────────────────────────

interface ModelPricing {
  inputCostPerM: number;
  outputCostPerM: number;
}

/**
 * Per-model pricing table (USD per million tokens).
 *
 * Maps model family keywords to their input/output pricing. Matching is
 * case-insensitive substring-based, so `claude-sonnet-4-6` matches the
 * `claude-sonnet` entry, `claude-opus-4-8` matches `claude-opus`, etc.
 *
 * Pricing sources (as of 2026-07):
 *   Claude Opus 4.x:  $15.00 / $75.00  per M tokens
 *   Claude Sonnet 4.x: $3.00 / $15.00  per M tokens
 *   Claude Haiku 4.x:  $0.25 / $1.25  per M tokens
 *   GPT-4o:            $2.50 / $10.00 per M tokens
 *   Default fallback:  $3.00 / $15.00 per M tokens
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus': { inputCostPerM: 15, outputCostPerM: 75 },
  'claude-sonnet': { inputCostPerM: 3, outputCostPerM: 15 },
  'claude-haiku': { inputCostPerM: 0.25, outputCostPerM: 1.25 },
  'gpt-4o': { inputCostPerM: 2.5, outputCostPerM: 10 },
};

const DEFAULT_PRICING: ModelPricing = { inputCostPerM: 3, outputCostPerM: 15 };

/**
 * Look up pricing for a given model ID.
 * Uses case-insensitive substring matching against known model families.
 */
function getPricing(model: string): ModelPricing {
  const lower = model.toLowerCase();
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (lower.includes(key)) return pricing;
  }
  return DEFAULT_PRICING;
}

/**
 * Estimate the USD cost for a given model's token usage.
 *
 * @param model            Model ID string (e.g. "claude-sonnet-4-6")
 * @param promptTokens     Number of prompt (input) tokens
 * @param completionTokens Number of completion (output) tokens
 * @returns Estimated cost in USD
 */
export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = getPricing(model);
  const inputCost = (promptTokens / 1_000_000) * pricing.inputCostPerM;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputCostPerM;
  return inputCost + outputCost;
}

// ── TokenUsageTracker ──────────────────────────────────────────────────────────

/**
 * Tracks per-session and cumulative token usage across all sessions.
 *
 * Records are stored in-memory and can be persisted to a JSON file via
 * `save()` / `load()`. The default storage path is `~/.babel_usage.json`.
 *
 * Usage:
 * ```ts
 * const tracker = new TokenUsageTracker();
 * await tracker.load();
 *
 * tracker.record({
 *   timestamp: Date.now(),
 *   sessionId: 'abc-123',
 *   model: 'claude-sonnet-4-6',
 *   promptTokens: 1000,
 *   completionTokens: 500,
 *   totalTokens: 1500,
 * });
 *
 * const summary = tracker.getSummary();
 * console.log(renderUsageSummary(summary));
 * await tracker.save();
 * ```
 */
export class TokenUsageTracker {
  private records: TokenUsageRecord[] = [];
  private readonly storagePath: string;

  constructor(storagePath?: string) {
    this.storagePath = storagePath ?? path.join(os.homedir(), '.babel_usage.json');
  }

  /**
   * Record one token usage entry.
   * The record is stored in memory — call `save()` to persist.
   */
  record(record: TokenUsageRecord): void {
    this.records.push(record);
  }

  /**
   * Compute usage summaries for today, this week, this month, and all-time.
   *
   * - Today: records since 00:00:00 local time today
   * - This week: records since the most recent Monday 00:00:00
   * - This month: records since the 1st of the current month 00:00:00
   * - All time: all records
   *
   * Cost is estimated using `estimateCost()` for each record.
   */
  getSummary(): UsageSummary {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    // Start of this week (Monday at 00:00:00)
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset).getTime();

    // Start of this month (1st at 00:00:00)
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    function sum(records: TokenUsageRecord[]): UsageSummaryPeriod {
      let promptTokens = 0;
      let completionTokens = 0;
      let totalTokens = 0;
      let cost = 0;
      for (const r of records) {
        promptTokens += r.promptTokens;
        completionTokens += r.completionTokens;
        totalTokens += r.totalTokens;
        cost += estimateCost(r.model, r.promptTokens, r.completionTokens);
      }
      return { promptTokens, completionTokens, totalTokens, cost };
    }

    return {
      today: sum(this.records.filter((r) => r.timestamp >= todayStart)),
      thisWeek: sum(this.records.filter((r) => r.timestamp >= weekStart)),
      thisMonth: sum(this.records.filter((r) => r.timestamp >= monthStart)),
      allTime: sum(this.records),
    };
  }

  /**
   * Get a per-model breakdown of token usage.
   * Returns a Map keyed by model ID.
   */
  getByModel(): Map<string, { promptTokens: number; completionTokens: number; totalTokens: number }> {
    const byModel = new Map<string, { promptTokens: number; completionTokens: number; totalTokens: number }>();
    for (const r of this.records) {
      const existing = byModel.get(r.model) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      existing.promptTokens += r.promptTokens;
      existing.completionTokens += r.completionTokens;
      existing.totalTokens += r.totalTokens;
      byModel.set(r.model, existing);
    }
    return byModel;
  }

  /**
   * Get daily token totals for the last `days` days.
   *
   * Returns an array sorted oldest-first, each entry containing a
   * human-readable date string and the total tokens for that day.
   *
   * @param days  Number of days to look back (including today)
   * @returns Array of { date, totalTokens } oldest-first
   */
  getDailyHistory(days: number): Array<{ date: string; totalTokens: number }> {
    const now = new Date();
    const result: Array<{ date: string; totalTokens: number }> = [];

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const dayStart = date.getTime();
      const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1).getTime();

      const dayRecords = this.records.filter((r) => r.timestamp >= dayStart && r.timestamp < dayEnd);
      const totalTokens = dayRecords.reduce((sum, r) => sum + r.totalTokens, 0);

      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
      result.push({ date: dateStr, totalTokens });
    }

    return result;
  }

  /**
   * Load records from the storage file (JSON).
   * If the file doesn't exist or is corrupt, starts with an empty record set.
   */
  async load(): Promise<void> {
    try {
      const data = await readFile(this.storagePath, 'utf-8');
      const parsed = JSON.parse(data) as unknown;
      if (Array.isArray(parsed)) {
        this.records = (parsed as TokenUsageRecord[]).filter(
          (r) => Number.isFinite(r.promptTokens) && Number.isFinite(r.completionTokens),
        );
        for (const r of this.records) {
          if (!Number.isFinite(r.totalTokens)) {
            r.totalTokens = (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
          }
        }
      } else {
        this.records = [];
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh
      this.records = [];
    }
  }

  /**
   * Save all records to the storage file as JSON.
   * Best-effort — failures are caught silently.
   */
  async save(): Promise<void> {
    try {
      const dir = path.dirname(this.storagePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      await writeFile(this.storagePath, JSON.stringify(this.records, null, 2), 'utf-8');
    } catch {
      // Best-effort — silent if filesystem is unwritable
    }
  }

  /**
   * Get a copy of all records.
   */
  getRecords(): TokenUsageRecord[] {
    return [...this.records];
  }

  /**
   * Remove all records (in-memory only — call `save()` to persist the clear).
   */
  clear(): void {
    this.records = [];
  }
}

// ── Chart rendering characters ─────────────────────────────────────────────────

/** Unicode block characters for smooth 1/8-step horizontal bars. */
const BAR_CHARS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];

/** Unicode braille characters for sparklines (low to high). */
const SPARKLINE_BRAILLE = ['⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿'];

// ── Render functions ───────────────────────────────────────────────────────────

/**
 * Render a horizontal bar chart using Unicode block characters.
 *
 * Produces output like:
 * ```
 *   Usage     ████████░░  80%
 * ```
 *
 * The bar is colored with `info()` (blue/cyan accent). The label is
 * right-padded and dimmed.
 *
 * @param value  The current value to visualize
 * @param max    The maximum value (100% fill)
 * @param width  Width of the bar in characters (not including label or percent)
 * @param label  Label text shown before the bar (padded to 10 chars)
 * @returns ANSI-escaped string, no trailing newline
 */
export function renderHorizontalBar(value: number, max: number, width: number, label: string): string {
  const ratio = Math.min(1, Math.max(0, value / Math.max(1, max)));
  const totalSteps = width * 8;
  const filledSteps = Math.round(ratio * totalSteps);
  const fullChars = Math.floor(filledSteps / 8);
  const partialIdx = filledSteps % 8;

  const bar = buildBarString(fullChars, partialIdx, width);
  const percent = Math.round(ratio * 100);
  const percentStr = `${percent}%`.padStart(4);

  return `${muted(label.padStart(10))} ${info(bar)} ${percentStr}`;
}

/**
 * Render a sparkline using Unicode braille characters.
 *
 * Each column represents one data point. Values are normalized to the
 * maximum value in the set and mapped to 7 braille levels:
 *
 *   ⣀ (lowest) → ⣄ → ⣤ → ⣦ → ⣶ → ⣷ → ⣿ (highest)
 *
 * Only the most recent `width` values are shown. The sparkline is
 * colored with `info()`.
 *
 * @param values  Array of numeric values (oldest first)
 * @param width   Maximum number of columns for the sparkline
 * @returns ANSI-escaped string of braille characters, or empty string
 */
export function renderSparkline(values: number[], width: number): string {
  if (values.length === 0 || width <= 0) return '';

  // Take the most recent `width` values
  const recent = values.slice(-width);
  const maxVal = Math.max(...recent, 1);
  const nChars = SPARKLINE_BRAILLE.length;

  let result = '';
  for (const v of recent) {
    const rawIdx = Math.floor((v / maxVal) * (nChars - 1));
    const idx = Math.max(0, Math.min(nChars - 1, rawIdx));
    result += SPARKLINE_BRAILLE[idx]!;
  }

  return info(result);
}

/**
 * Render a usage summary panel with Unicode box-drawing characters.
 *
 * Output format:
 * ```
 *   USAGE SUMMARY
 *   ┌──────────────────────┬──────────────┬──────────────┬──────────────┐
 *   │ Period               │ Tokens       │ Cost         │ Prompt/Comp  │
 *   ├──────────────────────┼──────────────┼──────────────┼──────────────┤
 *   │ Today                │       1.5k   │   $0.0150    │       50/50  │
 *   │ This Week            │       5.2k   │   $0.0520    │       48/52  │
 *   │ This Month           │      12.8k   │   $0.1280    │       45/55  │
 *   │ All Time             │      45.6k   │   $0.4560    │       47/53  │
 *   └──────────────────────┴──────────────┴──────────────┴──────────────┘
 * ```
 *
 * @param summary  The UsageSummary data to render
 * @returns ANSI-escaped multi-line string with no trailing newline
 */
export function renderUsageSummary(summary: UsageSummary): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`  ${sectionLabel('USAGE SUMMARY')}`);
  lines.push(`  ${muted('┌──────────────────────┬──────────────┬──────────────┬──────────────┐')}`);
  lines.push(`  ${muted('│')} ${bold('Period')}${muted('          │')} ${bold('Tokens')}${muted('      │')} ${bold('Cost')}${muted('        │')} ${bold('Prompt/Comp')}${muted(' │')}`);
  lines.push(`  ${muted('├──────────────────────┼──────────────┼──────────────┼──────────────┤')}`);

  function addPeriodRow(label: string, period: UsageSummaryPeriod): void {
    const tokenStr = formatTokenCount(period.totalTokens).padStart(9);
    const costStr = `$${period.cost.toFixed(4)}`.padStart(11);
    const ratio =
      period.totalTokens > 0
        ? `${Math.round((period.promptTokens / period.totalTokens) * 100)}/${Math.round((period.completionTokens / period.totalTokens) * 100)}`
        : '0/0';
    const ratioStr = ratio.padStart(12);
    lines.push(
      `  ${muted('│')} ${dim(label.padEnd(20))}${muted('│')} ${info(tokenStr)}${muted(' │')} ${accent(costStr)}${muted(' │')} ${muted(ratioStr)}${muted(' │')}`,
    );
  }

  addPeriodRow('Today', summary.today);
  addPeriodRow('This Week', summary.thisWeek);
  addPeriodRow('This Month', summary.thisMonth);
  addPeriodRow('All Time', summary.allTime);

  lines.push(`  ${muted('└──────────────────────┴──────────────┴──────────────┴──────────────┘')}`);

  return lines.join('\n');
}

/**
 * Render a per-model breakdown table showing token usage by model.
 *
 * Columns: Model | Prompt | Completion | Total | Cost
 * Sorted by total tokens descending.
 *
 * Output format:
 * ```
 *   TOKEN BREAKDOWN BY MODEL
 *   ┌──────────────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
 *   │ Model                │ Prompt       │ Completion   │ Total        │ Cost         │
 *   ├──────────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
 *   │ Claude Sonnet 4.6    │       1.0k   │       0.5k   │       1.5k   │   $0.0150    │
 *   │ Deepseek V4          │       0.8k   │       0.3k   │       1.1k   │   $0.0043    │
 *   └──────────────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
 * ```
 *
 * @param byModel  Map of model ID to usage statistics
 * @returns ANSI-escaped multi-line string, or empty string if the map is empty
 */
export function renderModelBreakdown(
  byModel: Map<string, { promptTokens: number; completionTokens: number; totalTokens: number }>,
): string {
  if (byModel.size === 0) return '';

  const lines: string[] = [];

  lines.push('');
  lines.push(`  ${sectionLabel('TOKEN BREAKDOWN BY MODEL')}`);
  lines.push(`  ${muted('┌──────────────────────┬──────────────┬──────────────┬──────────────┬──────────────┐')}`);
  lines.push(
    `  ${muted('│')} ${bold('Model')}${muted('               │')} ${bold('Prompt')}${muted('      │')} ${bold('Completion')}${muted('  │')} ${bold('Total')}${muted('       │')} ${bold('Cost')}${muted('        │')}`,
  );
  lines.push(`  ${muted('├──────────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤')}`);

  // Sort by total tokens descending
  const sorted = [...byModel.entries()].sort((a, b) => b[1].totalTokens - a[1].totalTokens);

  for (const [model, usage] of sorted) {
    const modelLabel = humanizeModelId(model).padEnd(20);
    const promptStr = formatTokenCount(usage.promptTokens).padStart(9);
    const compStr = formatTokenCount(usage.completionTokens).padStart(9);
    const totalStr = formatTokenCount(usage.totalTokens).padStart(9);
    const cost = estimateCost(model, usage.promptTokens, usage.completionTokens);
    const costStr = `$${cost.toFixed(4)}`.padStart(11);

    lines.push(
      `  ${muted('│')} ${dim(modelLabel)}${muted('│')} ${info(promptStr)}${muted(' │')} ${info(compStr)}${muted(' │')} ${info(totalStr)}${muted(' │')} ${accent(costStr)}${muted(' │')}`,
    );
  }

  lines.push(`  ${muted('└──────────────────────┴──────────────┴──────────────┴──────────────┴──────────────┘')}`);

  return lines.join('\n');
}

/**
 * Render a daily token usage chart showing the last N days.
 *
 * Each day row shows the date, a proportional horizontal bar, and the
 * token count. Below the rows, a braille sparkline shows the trend.
 *
 * Output format:
 * ```
 *   DAILY USAGE (Last 14 Days)
 *   Jul 01 ████████░░   80.0k
 *   Jun 30 ██████░░░░   60.0k
 *   Jun 29 ████░░░░░░   40.0k
 *   ...
 *   Trend  ⣀⣄⣤⣦⣶⣷⣿
 * ```
 *
 * @param history  Array of { date, totalTokens } sorted oldest-first
 * @param days     Number of days displayed (used in the section header)
 * @returns ANSI-escaped multi-line string with no trailing newline
 */
export function renderDailyChart(
  history: Array<{ date: string; totalTokens: number }>,
  days: number,
): string {
  if (history.length === 0) return '';

  const lines: string[] = [];
  const barWidth = Math.min(20, Math.max(8, Math.floor(60 / 3)));

  lines.push('');
  lines.push(`  ${sectionLabel(`DAILY USAGE (Last ${days} Days)`)}`);

  // Find max for scaling
  const maxTokens = Math.max(...history.map((h) => h.totalTokens), 1);

  for (const day of history) {
    const bar = renderBar(day.totalTokens, maxTokens, barWidth);
    const tokenStr = formatTokenCount(day.totalTokens).padStart(9);
    lines.push(`  ${muted(day.date)} ${bar} ${info(tokenStr)}`);
  }

  // Add sparkline of daily totals
  const sparkValues = history.map((h) => h.totalTokens);
  const sparkWidth = Math.min(barWidth + 12, Math.max(4, sparkValues.length));
  const sparkline = renderSparkline(sparkValues, sparkWidth);
  if (sparkline) {
    lines.push(`  ${muted('Trend')}  ${sparkline}`);
  }

  return lines.join('\n');
}

/**
 * Render a proportional distribution segment for use in pie-style displays.
 *
 * Each segment shows a filled block proportional to its share of the total,
 * the percentage, and the absolute value.
 *
 * @param value    The segment's value
 * @param total    The sum of all segments (100%)
 * @param width    Width in characters for the bar
 * @param label    Label for this segment
 * @param colorFn  ANSI color function for the bar fill
 * @returns ANSI-escaped string
 */
export function renderDistributionSegment(
  value: number,
  total: number,
  width: number,
  label: string,
  colorFn: (text: string) => string = info,
): string {
  const ratio = Math.min(1, Math.max(0, value / Math.max(1, total)));
  const barChars = Math.round(ratio * width);
  const bar = '█'.repeat(Math.max(1, barChars)).padEnd(width);
  const percent = Math.round(ratio * 100);
  return `${colorFn(bar)} ${muted(label.padEnd(16))} ${info(`${percent}%`.padStart(4))} ${dim(formatTokenCount(value))}`;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/** Build a bar string from filled/partial character counts. */
function buildBarString(fullChars: number, partialIdx: number, width: number): string {
  let bar = '';
  for (let i = 0; i < fullChars; i++) {
    bar += '█';
  }
  if (partialIdx > 0 && fullChars < width) {
    bar += BAR_CHARS[partialIdx]!;
  }
  const remaining = Math.max(0, width - fullChars - (partialIdx > 0 ? 1 : 0));
  for (let i = 0; i < remaining; i++) {
    bar += ' ';
  }
  return bar;
}

/** Render a horizontal bar without label (for daily chart rows). */
function renderBar(value: number, max: number, width: number): string {
  const ratio = Math.min(1, Math.max(0, value / Math.max(1, max)));
  const totalSteps = width * 8;
  const filledSteps = Math.round(ratio * totalSteps);
  const fullChars = Math.floor(filledSteps / 8);
  const partialIdx = filledSteps % 8;

  return info(buildBarString(fullChars, partialIdx, width));
}

/**
 * Format a token count into a human-readable string.
 * - >= 1M: "1.5M"
 * - >= 1k: "1.5k"
 * - Otherwise: raw number
 */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

/**
 * Convert a kebab-case model ID to a short human-readable label.
 */
function humanizeModelId(modelId: string): string {
  return modelId
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
