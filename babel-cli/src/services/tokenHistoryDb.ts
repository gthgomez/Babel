/**
 * TokenHistoryDb — SQLite-backed token usage persistence using node:sqlite.
 *
 * Provides structured storage for per-turn token records and session summaries,
 * replacing the JSONL append-only file with a queryable database.
 *
 * Schema:
 *   token_history   — one row per LLM turn
 *   session_summary — one row per session (aggregate, upserted on save)
 *
 * Database path: ~/.babel/token_history.db (overridable via BABEL_TOKEN_DB_PATH)
 *
 * @module tokenHistoryDb
 */

import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Schema SQL ─────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS token_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost REAL NOT NULL DEFAULT 0,
    model_id TEXT NOT NULL DEFAULT 'unknown',
    project_root TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_summary (
    session_id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0,
    turn_count INTEGER NOT NULL DEFAULT 0,
    project_root TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_token_history_session ON token_history(session_id);
  CREATE INDEX IF NOT EXISTS idx_token_history_timestamp ON token_history(timestamp);
`;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TokenTurnRow {
  /** Auto-increment primary key */
  id: number;
  /** Session identifier (e.g. UUID or "session-<date>") */
  sessionId: string;
  /** Date.now() when the turn was recorded */
  timestamp: number;
  /** Prompt tokens consumed in this turn */
  inputTokens: number;
  /** Completion tokens generated in this turn */
  outputTokens: number;
  /** Estimated USD cost for this turn */
  cost: number;
  /** Model identifier (e.g. "claude-sonnet-4-6") */
  modelId: string;
  /** Absolute path to the project root */
  projectRoot: string;
}

export interface SessionSummaryRow {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  turnCount: number;
  projectRoot: string;
}

export interface SessionUpsertData {
  startedAt?: number;
  endedAt?: number | null;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCost?: number;
  turnCount?: number;
  projectRoot: string;
}

export interface ProjectStatsResult {
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  firstSession: string | null;
  lastSession: string | null;
  sessionCount: number;
}

// ── Default path ───────────────────────────────────────────────────────────────

/**
 * Resolve the database path, checking the BABEL_TOKEN_DB_PATH env var first,
 * then falling back to ~/.babel/token_history.db.
 */
export function resolveTokenDbPath(override?: string): string {
  if (override) return override;
  const envPath = process.env['BABEL_TOKEN_DB_PATH']?.trim();
  if (envPath) return envPath;
  return path.join(os.homedir(), '.babel', 'token_history.db');
}

// ── TokenHistoryDb class ───────────────────────────────────────────────────────

/**
 * SQLite-backed persistence for token usage history.
 *
 * All database operations are synchronous (DatabaseSync) and best-effort.
 * Errors are caught and silently handled to avoid crashing the CLI.
 *
 * Usage:
 *   const db = new TokenHistoryDb();
 *   db.recordTurn('session-1', Date.now(), 1000, 500, 0.015, 'claude-sonnet-4-6', '/project');
 *   const history = db.getSessionHistory('session-1');
 *   db.close();
 */
export class TokenHistoryDb {
  private db: DatabaseSync | null = null;
  private dbPath: string;
  private _initAttempted = false;

  constructor(dbPath?: string) {
    this.dbPath = resolveTokenDbPath(dbPath);
  }

  // ── Initialization ────────────────────────────────────────────────────────

  /**
   * Lazily initialise the database connection and schema.
   * Called automatically before any operation that needs the database.
   */
  private ensureOpen(): void {
    if (this.db) return;
    if (this._initAttempted) return; // Don't retry after first failure
    this._initAttempted = true;

    try {
      // Ensure the parent directory exists
      const dir = path.dirname(this.dbPath);
      // mkdirSync is in the parent call — we use the fs pattern from sqliteChronicleStore
      // which relies on the caller to ensure directories exist, but let's be robust:
      try {
        const { mkdirSync } = require('node:fs') as typeof import('node:fs');
        mkdirSync(dir, { recursive: true });
      } catch {
        // Best-effort — if we can't create the dir, the connection will fail below
      }

      this.db = new DatabaseSync(this.dbPath);
      // Enable WAL mode for better concurrent read/write performance
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA synchronous=NORMAL');
      this.db.exec(SCHEMA_SQL);
    } catch {
      // Database unavailable — all operations become no-ops
      this.db = null;
    }
  }

  /**
   * Check whether the database is available for queries.
   */
  get isAvailable(): boolean {
    this.ensureOpen();
    return this.db !== null;
  }

  // ── Token history CRUD ────────────────────────────────────────────────────

  /**
   * Record one turn's token usage in the token_history table.
   * Best-effort — failures are caught silently.
   */
  recordTurn(
    sessionId: string,
    timestamp: number,
    inputTokens: number,
    outputTokens: number,
    cost: number,
    modelId: string,
    projectRoot: string,
  ): void {
    this.ensureOpen();
    if (!this.db) return;

    try {
      this.db
        .prepare(
          `
          INSERT INTO token_history (session_id, timestamp, input_tokens, output_tokens, cost, model_id, project_root)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(sessionId, timestamp, inputTokens, outputTokens, cost, modelId, projectRoot);
    } catch {
      // Best-effort — silent if DB is corrupt or unwritable
    }
  }

  /**
   * Retrieve all recorded turns for a given session, ordered oldest first.
   */
  getSessionHistory(sessionId: string): TokenTurnRow[] {
    this.ensureOpen();
    if (!this.db) return [];

    try {
      const rows = this.db
        .prepare(
          `
          SELECT id, session_id, timestamp, input_tokens, output_tokens, cost, model_id, project_root
            FROM token_history
           WHERE session_id = ?
           ORDER BY timestamp ASC
        `,
        )
        .all(sessionId) as Array<Record<string, unknown>>;

      return rows.map(mapToTokenTurnRow);
    } catch {
      return [];
    }
  }

  /**
   * Retrieve the most recent N turns across all sessions (for sparkline rendering).
   * Defaults to 20 turns.
   */
  getRecentTurns(limit: number = 20): TokenTurnRow[] {
    this.ensureOpen();
    if (!this.db) return [];

    try {
      const rows = this.db
        .prepare(
          `
          SELECT id, session_id, timestamp, input_tokens, output_tokens, cost, model_id, project_root
            FROM token_history
           ORDER BY timestamp DESC
           LIMIT ?
        `,
        )
        .all(Math.max(1, Math.min(limit, 10000))) as Array<Record<string, unknown>>;

      // Reverse so caller gets oldest-first order
      return rows.map(mapToTokenTurnRow).reverse();
    } catch {
      return [];
    }
  }

  /**
   * Get aggregate usage statistics for a project, optionally filtered to turns
   * since a given timestamp (Unix ms).
   */
  getProjectStats(projectRoot: string, since?: number): ProjectStatsResult {
    this.ensureOpen();
    if (!this.db) {
      return {
        totalTurns: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        firstSession: null,
        lastSession: null,
        sessionCount: 0,
      };
    }

    try {
      const aggRows = (since !== undefined
        ? this.db
            .prepare(
              `
              SELECT COUNT(*) as turn_count,
                     COALESCE(SUM(input_tokens), 0) as total_in,
                     COALESCE(SUM(output_tokens), 0) as total_out,
                     COALESCE(SUM(cost), 0) as total_cost
                FROM token_history
               WHERE project_root = ? AND timestamp >= ?
            `,
            )
            .all(projectRoot, since)
        : this.db
            .prepare(
              `
              SELECT COUNT(*) as turn_count,
                     COALESCE(SUM(input_tokens), 0) as total_in,
                     COALESCE(SUM(output_tokens), 0) as total_out,
                     COALESCE(SUM(cost), 0) as total_cost
                FROM token_history
               WHERE project_root = ?
            `,
            )
            .all(projectRoot)) as Array<Record<string, unknown>>;

      const agg = aggRows[0] ?? { turn_count: 0, total_in: 0, total_out: 0, total_cost: 0 };

      // Get first and last session IDs
      const sessionRows = this.db
        .prepare(
          `
          SELECT session_id, COUNT(DISTINCT session_id) as session_count
            FROM token_history
           WHERE project_root = ?
           GROUP BY session_id
           ORDER BY MIN(timestamp) ASC
        `,
        )
        .all(projectRoot) as Array<{ session_id: string; session_count: number }>;

      return {
        totalTurns: Number(agg['turn_count'] ?? 0),
        totalInputTokens: Number(agg['total_in'] ?? 0),
        totalOutputTokens: Number(agg['total_out'] ?? 0),
        totalCost: Number(agg['total_cost'] ?? 0),
        firstSession: sessionRows.length > 0 ? String(sessionRows[0]!.session_id) : null,
        lastSession: sessionRows.length > 0 ? String(sessionRows[sessionRows.length - 1]!.session_id) : null,
        sessionCount: sessionRows.length,
      };
    } catch {
      return {
        totalTurns: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        firstSession: null,
        lastSession: null,
        sessionCount: 0,
      };
    }
  }

  // ── Session summary ───────────────────────────────────────────────────────

  /**
   * Upsert a session summary row. Uses INSERT OR REPLACE so any existing
   * row with the same session_id is overwritten.
   */
  upsertSessionSummary(sessionId: string, data: SessionUpsertData): void {
    this.ensureOpen();
    if (!this.db) return;

    try {
      // First, check if a row already exists
      const existing = this.db
        .prepare('SELECT * FROM session_summary WHERE session_id = ?')
        .get(sessionId) as Record<string, unknown> | undefined;

      if (existing) {
        // Merge: existing values serve as defaults, data fields override
        this.db
          .prepare(
            `
            UPDATE session_summary
               SET ended_at = ?,
                   total_input_tokens = ?,
                   total_output_tokens = ?,
                   total_cost = ?,
                   turn_count = ?,
                   project_root = ?
             WHERE session_id = ?
          `,
          )
          .run(
            data.endedAt !== undefined ? data.endedAt : (existing['ended_at'] as number | null) ?? null,
            data.totalInputTokens !== undefined
              ? data.totalInputTokens
              : (existing['total_input_tokens'] as number) ?? 0,
            data.totalOutputTokens !== undefined
              ? data.totalOutputTokens
              : (existing['total_output_tokens'] as number) ?? 0,
            data.totalCost !== undefined ? data.totalCost : (existing['total_cost'] as number) ?? 0,
            data.turnCount !== undefined ? data.turnCount : (existing['turn_count'] as number) ?? 0,
            data.projectRoot,
            sessionId,
          );
      } else {
        // Insert new row
        this.db
          .prepare(
            `
            INSERT INTO session_summary (session_id, started_at, ended_at, total_input_tokens, total_output_tokens, total_cost, turn_count, project_root)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            sessionId,
            data.startedAt ?? Date.now(),
            data.endedAt ?? null,
            data.totalInputTokens ?? 0,
            data.totalOutputTokens ?? 0,
            data.totalCost ?? 0,
            data.turnCount ?? 0,
            data.projectRoot,
          );
      }
    } catch {
      // Best-effort — silent if DB is corrupt or unwritable
    }
  }

  /**
   * Retrieve a session summary row.
   */
  getSessionSummary(sessionId: string): SessionSummaryRow | null {
    this.ensureOpen();
    if (!this.db) return null;

    try {
      const row = this.db
        .prepare(
          `
          SELECT session_id, started_at, ended_at,
                 total_input_tokens, total_output_tokens, total_cost,
                 turn_count, project_root
            FROM session_summary
           WHERE session_id = ?
        `,
        )
        .get(sessionId) as Record<string, unknown> | undefined;

      if (!row) return null;

      return {
        sessionId: String(row['session_id'] ?? ''),
        startedAt: Number(row['started_at'] ?? 0),
        endedAt: row['ended_at'] !== null ? Number(row['ended_at']) : null,
        totalInputTokens: Number(row['total_input_tokens'] ?? 0),
        totalOutputTokens: Number(row['total_output_tokens'] ?? 0),
        totalCost: Number(row['total_cost'] ?? 0),
        turnCount: Number(row['turn_count'] ?? 0),
        projectRoot: String(row['project_root'] ?? ''),
      };
    } catch {
      return null;
    }
  }

  // ── Aggregated historical queries ─────────────────────────────────────────

  /**
   * Get total cost across all sessions for a project.
   */
  getProjectTotalCost(projectRoot: string): number {
    const stats = this.getProjectStats(projectRoot);
    return stats.totalCost;
  }

  /**
   * Get session summaries for a project, ordered by start time descending.
   */
  getProjectSessionSummaries(projectRoot: string, limit: number = 10): SessionSummaryRow[] {
    this.ensureOpen();
    if (!this.db) return [];

    try {
      const rows = this.db
        .prepare(
          `
          SELECT session_id, started_at, ended_at,
                 total_input_tokens, total_output_tokens, total_cost,
                 turn_count, project_root
            FROM session_summary
           WHERE project_root = ?
           ORDER BY started_at DESC
           LIMIT ?
        `,
        )
        .all(projectRoot, Math.max(1, Math.min(limit, 100))) as Array<Record<string, unknown>>;

      return rows.map((row) => ({
        sessionId: String(row['session_id'] ?? ''),
        startedAt: Number(row['started_at'] ?? 0),
        endedAt: row['ended_at'] !== null ? Number(row['ended_at']) : null,
        totalInputTokens: Number(row['total_input_tokens'] ?? 0),
        totalOutputTokens: Number(row['total_output_tokens'] ?? 0),
        totalCost: Number(row['total_cost'] ?? 0),
        turnCount: Number(row['turn_count'] ?? 0),
        projectRoot: String(row['project_root'] ?? ''),
      }));
    } catch {
      return [];
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Close the database connection. Safe to call multiple times.
   */
  close(): void {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {
      // Already closed
    }
    this.db = null;
  }
}

// ── Row mapper ─────────────────────────────────────────────────────────────────

function mapToTokenTurnRow(row: Record<string, unknown>): TokenTurnRow {
  return {
    id: Number(row['id'] ?? 0),
    sessionId: String(row['session_id'] ?? ''),
    timestamp: Number(row['timestamp'] ?? 0),
    inputTokens: Number(row['input_tokens'] ?? 0),
    outputTokens: Number(row['output_tokens'] ?? 0),
    cost: Number(row['cost'] ?? 0),
    modelId: String(row['model_id'] ?? ''),
    projectRoot: String(row['project_root'] ?? ''),
  };
}

// ── Global singleton ───────────────────────────────────────────────────────────

let _globalTokenDb: TokenHistoryDb | null = null;

/**
 * Get or create the global TokenHistoryDb singleton.
 *
 * The database path is resolved from:
 *   1. `dbPath` argument (if provided)
 *   2. `BABEL_TOKEN_DB_PATH` env var
 *   3. `~/.babel/token_history.db` (default)
 */
export function getGlobalTokenHistoryDb(dbPath?: string): TokenHistoryDb {
  if (!_globalTokenDb) {
    _globalTokenDb = new TokenHistoryDb(dbPath);
  }
  return _globalTokenDb;
}

/**
 * Close and reset the global singleton. Used primarily in tests.
 */
export function resetGlobalTokenHistoryDb(): void {
  if (_globalTokenDb) {
    _globalTokenDb.close();
    _globalTokenDb = null;
  }
}
