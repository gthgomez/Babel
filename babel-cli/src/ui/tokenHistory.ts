/**
 * TokenHistory — token usage history tracker + sparkline renderer.
 *
 * Tracks per-turn token consumption and renders a Unicode sparkline
 * showing usage trends across recent turns. Designed to complement
 * the token bar in tokenBar.ts with a lightweight historical view.
 *
 * Usage:
 *   import { TokenUsageTracker, renderTokenSparkline, renderTokenSummary }
 *     from './tokenHistory.js';
 *
 *   const tracker = new TokenUsageTracker();
 *   tracker.record({ inputTokens: 1000, outputTokens: 500, cost: 0.015, modelId: 'claude-sonnet-4-6' });
 *
 *   // Render a 20-column sparkline of recent turn totals
 *   process.stdout.write(renderTokenSparkline(tracker.getHistory(), 20));
 *
 * @module tokenHistory
 */

import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { accent, info, muted, ghost } from './theme.js';
import { getGlobalTokenHistoryDb } from '../services/tokenHistoryDb.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TokenUsageRecord {
  /** Date.now() when the record was created */
  timestamp: number;
  /** Prompt tokens consumed in this turn */
  inputTokens: number;
  /** Completion tokens generated in this turn */
  outputTokens: number;
  /** Estimated USD cost for this turn */
  cost: number;
  /** Model ID that handled this turn (e.g. "claude-sonnet-4-6") */
  modelId: string;
}

// ── History tracker ───────────────────────────────────────────────────────────

/**
 * Tracks per-turn token usage across a session with a fixed-size ring buffer.
 * Default capacity: 200 records (approximately the last 200 turns).
 */
export class TokenUsageTracker {
  private records: TokenUsageRecord[] = [];
  private readonly maxRecords: number;
  private persistPath: string | undefined;
  private _dirChecked: boolean = false;
  /** Session identifier for SQLite persistence (from BABEL_SESSION_ID or set directly). */
  private _sessionId: string | undefined;
  /** Project root for SQLite persistence (set from project context). */
  private _projectRoot: string | undefined;

  constructor(maxRecords: number = 200, persistPath?: string) {
    if (maxRecords < 1) throw new Error('maxRecords must be >= 1');
    this.maxRecords = maxRecords;
    this.persistPath = persistPath;
  }

  /**
   * Record one turn's token usage. If the tracker is at capacity,
   * the oldest record is dropped.
   *
   * When a persistence path is configured, each record is also appended
   * as a JSONL line to the file (best-effort). This ensures token history
   * survives CLI restarts even if the process is killed unexpectedly.
   */
  record(usage: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
    modelId: string;
    timestamp?: number;
  }): void {
    const record: TokenUsageRecord = {
      timestamp: usage.timestamp ?? Date.now(),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost: usage.cost,
      modelId: usage.modelId,
    };
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
    // Auto-persist: append one JSONL line (best-effort)
    this._appendPersist(record);

    // Also persist to SQLite when session + project context is available.
    // This is additive — JSONL remains as a fallback for backward compatibility.
    this._persistToSqlite(record);
  }

  /** Set the persistence path for auto-persist on every record(). */
  setPersistPath(filePath: string): void {
    this.persistPath = filePath;
  }

  /** Get the current persistence path, if set. */
  getPersistPath(): string | undefined {
    return this.persistPath;
  }

  /** Set the session ID for SQLite persistence. */
  setSessionId(id: string): void {
    this._sessionId = id;
  }

  /** Get the current session ID, if set. */
  getSessionId(): string | undefined {
    return this._sessionId;
  }

  /** Set the project root for SQLite persistence. */
  setProjectRoot(root: string): void {
    this._projectRoot = root;
  }

  /** Get the current project root, if set. */
  getProjectRoot(): string | undefined {
    return this._projectRoot;
  }

  /** Return a copy of all stored records (oldest first). */
  getHistory(): TokenUsageRecord[] {
    return [...this.records];
  }

  /** Return the most recent `count` records. */
  getRecentTurns(count: number): TokenUsageRecord[] {
    return this.records.slice(-count);
  }

  /** Sum of all recorded costs. */
  getTotalCost(): number {
    return this.records.reduce((sum, r) => sum + r.cost, 0);
  }

  /** Sum of all recorded input and output tokens. */
  getTotalTokens(): { input: number; output: number } {
    let input = 0;
    let output = 0;
    for (const r of this.records) {
      input += r.inputTokens;
      output += r.outputTokens;
    }
    return { input, output };
  }

  /** Remove all records. */
  clear(): void {
    this.records = [];
  }

  /**
   * Batch-load records into the ring buffer without triggering auto-persist.
   * Used by loadTokenHistory() to avoid re-appending records that were
   * just read from disk.
   */
  _injectRecords(records: TokenUsageRecord[]): void {
    for (const r of records) {
      this.records.push(r);
    }
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  /**
   * Append one record to the persistence file (JSONL).
   * Best-effort — failures are caught silently.
   */
  private _appendPersist(record: TokenUsageRecord): void {
    if (!this.persistPath) return;
    try {
      if (!this._dirChecked) {
        mkdirSync(path.dirname(this.persistPath), { recursive: true });
        this._dirChecked = true;
      }
      appendFileSync(this.persistPath, JSON.stringify(record) + '\n', 'utf-8');
    } catch {
      // Best-effort — silent if filesystem is unwritable
    }
  }

  /**
   * Persist one record to SQLite via the global TokenHistoryDb.
   * Only writes when both sessionId and projectRoot are configured on the tracker.
   * Best-effort — failures are caught silently.
   *
   * This is additive to the JSONL persistence. If the SQLite write fails
   * (e.g., DB is corrupt), JSONL remains as a fallback.
   */
  private _persistToSqlite(record: TokenUsageRecord): void {
    const sessionId = this._sessionId ?? process.env['BABEL_SESSION_ID']?.trim();
    if (!sessionId) return;
    const projectRoot = this._projectRoot ?? process.env['BABEL_PROJECT_ROOT']?.trim();
    if (!projectRoot) return;

    try {
      const db = getGlobalTokenHistoryDb();
      db.recordTurn(
        sessionId,
        record.timestamp,
        record.inputTokens,
        record.outputTokens,
        record.cost,
        record.modelId,
        projectRoot,
      );
    } catch {
      // Best-effort — silent if DB is unavailable
    }
  }
}

// ── Sparkline renderer ────────────────────────────────────────────────────────

/** Unicode sparkline characters from lowest (▁) to highest (█). */
const SPARKLINE_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Pick an ANSI colour function based on the model family.
 *   Claude   → accent (purple/blue)
 *   DeepSeek → info   (blue/cyan)
 *   Other    → muted  (dim gray)
 */
function getModelColor(modelId: string): (text: string) => string {
  const id = modelId.toLowerCase();
  if (id.includes('claude')) return accent;
  if (id.includes('deepseek')) return info;
  return muted;
}

/**
 * Render a compact token usage sparkline.
 *
 * Each column represents one turn. The most recent `width` turns are
 * shown from left to right, so the rightmost column is the latest turn.
 *
 * @param records  Historical token usage records (oldest first).
 * @param width    Number of terminal columns for the sparkline.
 * @param maxValue Optional fixed max for the vertical scale. When omitted,
 *                 auto-scales to the highest value in the visible range.
 * @returns ANSI-escaped string of coloured sparkline characters.
 */
export function renderTokenSparkline(
  records: TokenUsageRecord[],
  width: number,
  maxValue?: number,
): string {
  if (records.length === 0 || width <= 0) return '';

  // Take the most recent `width` records, one column per turn.
  const recent = records.slice(-width);

  // Compute total tokens per turn for the visible window.
  const visibleMax = maxValue ?? Math.max(...recent.map((r) => r.inputTokens + r.outputTokens), 1);
  const nChars = SPARKLINE_CHARS.length;

  let result = '';
  for (const record of recent) {
    const totalTokens = record.inputTokens + record.outputTokens;
    const rawIdx = Math.floor((totalTokens / visibleMax) * nChars);
    const idx = Math.max(0, Math.min(nChars - 1, rawIdx));
    const colorFn = getModelColor(record.modelId);
    result += colorFn(SPARKLINE_CHARS[idx]!);
  }

  return result;
}

// ── Token count formatting ────────────────────────────────────────────────────

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

// ── Summary renderer ──────────────────────────────────────────────────────────

/**
 * Render a multi-line token summary: sparkline line + cost/total line.
 *
 * Output format:
 *   ▃▅▆▇█▆▅▄▃▁
 *   Cost: $0.0150  1.5k total tokens
 *
 * @returns ANSI-escaped multi-line string with no trailing newline.
 *          Returns empty string when the tracker has no records.
 */
export function renderTokenSummary(tracker: TokenUsageTracker, width: number): string {
  const history = tracker.getHistory();
  if (history.length === 0) return '';

  const sparkline = renderTokenSparkline(history, width);
  const totalCost = tracker.getTotalCost();
  const totals = tracker.getTotalTokens();
  const totalTokens = totals.input + totals.output;

  const costStr = totalCost > 0 ? `$${totalCost.toFixed(4)}` : '$0.0000';
  const tokenStr = formatTokenCount(totalTokens);

  return `${sparkline}\n${muted(`Cost: ${costStr}`)}  ${ghost(`${tokenStr} total tokens`)}`;
}

// ── Global singleton ──────────────────────────────────────────────────────

let _globalTracker: TokenUsageTracker | null = null;

/**
 * Get or create the global token usage tracker.
 *
 * When called without arguments, creates the tracker with a default
 * persistence path at `~/.babel/token-history.json` so that every
 * `record()` call auto-persists via JSONL append.
 *
 * @param persistPath  Optional override for the persistence path. Pass an
 *                     empty string to create a non-persisting tracker.
 *                     Omitted → uses `~/.babel/token-history.json`.
 * @param sessionId    Optional session ID for SQLite persistence.
 * @param projectRoot  Optional project root for SQLite persistence.
 */
export function getGlobalTokenTracker(
  persistPath?: string,
  sessionId?: string,
  projectRoot?: string,
): TokenUsageTracker {
  if (!_globalTracker) {
    const resolvedPath =
      persistPath !== undefined
        ? persistPath
        : path.join(os.homedir(), '.babel', 'token-history.json');
    _globalTracker = new TokenUsageTracker(200, resolvedPath || undefined);
  } else if (persistPath !== undefined && persistPath) {
    _globalTracker.setPersistPath(persistPath);
  }
  if (sessionId) {
    _globalTracker.setSessionId(sessionId);
  }
  if (projectRoot) {
    _globalTracker.setProjectRoot(projectRoot);
  }
  return _globalTracker;
}

/**
 * Save all token records to a JSONL file (one JSON record per line).
 * Uses atomic write (write to .tmp, then rename) to avoid corruption.
 *
 * Also sets the tracker's persist path so subsequent `record()` calls
 * auto-append to the same file.
 *
 * @param filePath  Path to the JSONL file.
 * @param tracker   Optional tracker instance. Defaults to the global singleton.
 */
export function saveTokenHistory(filePath: string, tracker?: TokenUsageTracker): void {
  const t = tracker ?? getGlobalTokenTracker();
  t.setPersistPath(filePath);
  try {
    const records = t.getHistory();
    const data = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, data, 'utf-8');
    renameSync(tmp, filePath);
  } catch {
    // Best-effort — silent if home dir is unwritable
  }
}

/**
 * Load token records from a file, supporting two formats:
 *   - **JSONL** (new): one JSON object per line, created by auto-persist
 *   - **JSON array** (legacy): `[{...}, {...}]`, created by older versions
 *
 * Also sets the tracker's persist path to `filePath` so subsequent
 * `record()` calls auto-append.
 *
 * Tries SQLite first if the tracker has session context. Falls back to JSONL
 * when SQLite returns no data or is unavailable.
 *
 * Corrupt or partial lines in JSONL are silently skipped.
 *
 * @param filePath  Path to the JSONL file.
 * @param tracker   Optional tracker instance. Defaults to the global singleton.
 */
export function loadTokenHistory(filePath: string, tracker?: TokenUsageTracker): void {
  const t = tracker ?? getGlobalTokenTracker();
  t.setPersistPath(filePath);

  // Try SQLite first when session context is available
  const sessionId = t.getSessionId() ?? process.env['BABEL_SESSION_ID']?.trim();
  if (sessionId) {
    try {
      const db = getGlobalTokenHistoryDb();
      const sqliteRecords = db.getSessionHistory(sessionId);
      if (sqliteRecords.length > 0) {
        t._injectRecords(
          sqliteRecords.map((row) => ({
            timestamp: row.timestamp,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cost: row.cost,
            modelId: row.modelId,
          })),
        );
        return; // SQLite had data — skip JSONL fallback
      }
    } catch {
      // SQLite unavailable or empty — fall through to JSONL
    }
  }

  // Fallback: load from JSONL file
  try {
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) return;

    let records: TokenUsageRecord[] = [];

    // Try JSON array first (legacy format: starts with '[')
    if (raw.startsWith('[')) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        records = parsed as TokenUsageRecord[];
      }
    } else {
      // JSONL format: one JSON object per line
      const lines = raw.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          records.push(JSON.parse(trimmed) as TokenUsageRecord);
        } catch {
          // Skip corrupt/partial lines (crash recovery)
        }
      }
    }

    t._injectRecords(records);
  } catch {
    // File doesn't exist or is corrupt — start fresh
  }
}
