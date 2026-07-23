import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { threadDir, threadsDir } from '../../cli/runsLayout.js';
import type { HistoryCellRecord, UserMessagePayload } from '../../ui/historyCells/types.js';
import type { ListThreadsOptions, ThreadMeta, TurnBounds } from './types.js';

const CELLS_FILE = 'cells.jsonl';
const META_DB = 'meta.sqlite';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS thread_meta (
    thread_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    turn_count INTEGER NOT NULL DEFAULT 0,
    cell_count INTEGER NOT NULL DEFAULT 0,
    project_root TEXT,
    preview TEXT,
    resume_line_offset INTEGER NOT NULL DEFAULT 0,
    parent_thread_id TEXT,
    fork_point_cell_id TEXT
  );

  CREATE TABLE IF NOT EXISTS cells (
    cell_id TEXT PRIMARY KEY,
    turn_id INTEGER,
    line_offset INTEGER NOT NULL,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS turn_bounds (
    turn_id INTEGER PRIMARY KEY,
    first_cell_id TEXT NOT NULL,
    last_cell_id TEXT NOT NULL,
    first_line_offset INTEGER NOT NULL,
    last_line_offset INTEGER NOT NULL,
    cell_count INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cells_turn ON cells(turn_id);
`;

export function getThreadDir(threadId: string): string {
  return threadDir(threadId);
}

function getCellsPath(threadId: string): string {
  return join(getThreadDir(threadId), CELLS_FILE);
}

function getMetaDbPath(threadId: string): string {
  return join(getThreadDir(threadId), META_DB);
}

function openMetaDb(threadId: string): DatabaseSync {
  const dir = getThreadDir(threadId);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(getMetaDbPath(threadId));
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA busy_timeout=10000');
  db.exec(SCHEMA_SQL);
  return db;
}

function countJsonlLines(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  const content = readFileSync(filePath, 'utf8');
  if (!content) return 0;
  return content.split('\n').filter((line) => line.trim().length > 0).length;
}

function previewFromRecord(record: HistoryCellRecord): string | null {
  if (record.kind === 'user_message') {
    const message = (record.payload as UserMessagePayload).message.trim();
    return message.length > 0 ? message.slice(0, 120) : null;
  }
  return null;
}

function groupRecordsByTurn(records: HistoryCellRecord[]): Map<number, HistoryCellRecord[]> {
  const byTurn = new Map<number, HistoryCellRecord[]>();
  for (const record of records) {
    const turnId = record.turn_id ?? 0;
    const bucket = byTurn.get(turnId) ?? [];
    bucket.push(record);
    byTurn.set(turnId, bucket);
  }
  return byTurn;
}

function previewFromRecords(records: HistoryCellRecord[]): string | null {
  const previewRecord = [...records].reverse().find((record) => record.kind === 'user_message');
  return previewRecord ? previewFromRecord(previewRecord) : null;
}

function normalizeCommittedRecord(
  threadId: string,
  record: HistoryCellRecord,
  turnId?: number,
): HistoryCellRecord {
  const normalized = {
    ...structuredClone(record),
    thread_id: record.thread_id ?? threadId,
    lifecycle: 'committed' as const,
  };
  const resolvedTurnId = record.turn_id ?? turnId;
  if (resolvedTurnId !== undefined) {
    normalized.turn_id = resolvedTurnId;
  }
  return normalized;
}

function writeCellsJsonl(threadId: string, records: HistoryCellRecord[]): void {
  const cellsPath = getCellsPath(threadId);
  const lines = records.map((record) =>
    JSON.stringify(normalizeCommittedRecord(threadId, record, record.turn_id)),
  );
  writeFileSync(cellsPath, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
}

async function syncSqliteIndexFromRecords(
  db: DatabaseSync,
  threadId: string,
  records: HistoryCellRecord[],
  options: {
    preserveMeta?: {
      created_at?: number;
      project_root?: string | null;
      preview?: string | null;
      parent_thread_id?: string | null;
      fork_point_cell_id?: string | null;
    };
  } = {},
): Promise<void> {
  let maxTurn = 0;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM cells');
    db.exec('DELETE FROM turn_bounds');

    const insertCell = db.prepare(
      `INSERT INTO cells (cell_id, turn_id, line_offset, ts, kind) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertTurn = db.prepare(
      `INSERT INTO turn_bounds (
         turn_id, first_cell_id, last_cell_id,
         first_line_offset, last_line_offset, cell_count
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );

    let lineOffset = 0;
    let batchCount = 0;
    const byTurn = groupRecordsByTurn(records);

    for (const [turnId, turnRecords] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
      if (turnRecords.length === 0) continue;
      maxTurn = Math.max(maxTurn, turnId);
      const first = turnRecords[0]!;
      const last = turnRecords[turnRecords.length - 1]!;
      const firstLine = lineOffset;
      for (const record of turnRecords) {
        insertCell.run(record.cell_id, turnId, lineOffset, record.ts, record.kind);
        lineOffset += 1;
        if (++batchCount >= 100) {
          batchCount = 0;
          // Yield the event loop while keeping the transaction open.
          // Safe because: (1) this DatabaseSync handle is scoped to this
          // call with no concurrent access, (2) the per-thread meta.sqlite
          // is never accessed by other connections during this call, and
          // (3) WAL mode ensures crash recovery rolls back the open
          // transaction on next database open.
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      insertTurn.run(
        turnId,
        first.cell_id,
        last.cell_id,
        firstLine,
        lineOffset - 1,
        turnRecords.length,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const now = Date.now();
  const preview = previewFromRecords(records);
  const preserve = options.preserveMeta ?? {};

  db.prepare(
    `INSERT INTO thread_meta (
       thread_id, created_at, updated_at, turn_count, cell_count,
       project_root, preview, resume_line_offset,
       parent_thread_id, fork_point_cell_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       updated_at = excluded.updated_at,
       turn_count = excluded.turn_count,
       cell_count = excluded.cell_count,
       preview = COALESCE(excluded.preview, thread_meta.preview),
       resume_line_offset = excluded.resume_line_offset`,
  ).run(
    threadId,
    preserve.created_at ?? now,
    now,
    maxTurn,
    records.length,
    preserve.project_root ?? null,
    preview ?? preserve.preview ?? null,
    Math.max(0, records.length - 1),
    preserve.parent_thread_id ?? null,
    preserve.fork_point_cell_id ?? null,
  );
}

function mapThreadMeta(row: Record<string, unknown>): ThreadMeta {
  return {
    thread_id: String(row['thread_id'] ?? ''),
    created_at: Number(row['created_at'] ?? 0),
    updated_at: Number(row['updated_at'] ?? 0),
    turn_count: Number(row['turn_count'] ?? 0),
    cell_count: Number(row['cell_count'] ?? 0),
    project_root: row['project_root'] != null ? String(row['project_root']) : null,
    preview: row['preview'] != null ? String(row['preview']) : null,
    resume_line_offset: Number(row['resume_line_offset'] ?? 0),
  };
}

export function threadStoreExists(threadId: string): boolean {
  const cellsPath = getCellsPath(threadId);
  const metaPath = getMetaDbPath(threadId);
  return existsSync(cellsPath) || existsSync(metaPath);
}

export function ensureThread(threadId: string, meta?: Partial<ThreadMeta>): void {
  const dir = getThreadDir(threadId);
  mkdirSync(dir, { recursive: true });

  const db = openMetaDb(threadId);
  try {
    const now = Date.now();
    const existing = db
      .prepare('SELECT thread_id FROM thread_meta WHERE thread_id = ?')
      .get(threadId) as Record<string, unknown> | undefined;

    if (!existing) {
      db.prepare(
        `
        INSERT INTO thread_meta (
          thread_id, created_at, updated_at, turn_count, cell_count,
          project_root, preview, resume_line_offset
        ) VALUES (?, ?, ?, 0, 0, ?, ?, 0)
      `,
      ).run(
        threadId,
        meta?.created_at ?? now,
        meta?.updated_at ?? now,
        meta?.project_root ?? null,
        meta?.preview ?? null,
      );
    } else if (meta) {
      db.prepare(
        `
        UPDATE thread_meta
           SET updated_at = ?,
               project_root = COALESCE(?, project_root),
               preview = COALESCE(?, preview)
         WHERE thread_id = ?
      `,
      ).run(meta.updated_at ?? now, meta.project_root ?? null, meta.preview ?? null, threadId);
    }
  } finally {
    db.close();
  }
}

export function resolveNextTurnId(threadId: string): number {
  const meta = getThreadMeta(threadId);
  return (meta?.turn_count ?? 0) + 1;
}

export function appendTurnCells(
  threadId: string,
  turnId: number,
  records: HistoryCellRecord[],
): void {
  if (records.length === 0) return;

  ensureThread(threadId);
  const cellsPath = getCellsPath(threadId);
  const startLineOffset = countJsonlLines(cellsPath);
  const lines: string[] = [];

  for (const record of records) {
    lines.push(JSON.stringify(normalizeCommittedRecord(threadId, record, turnId)));
  }

  appendFileSync(cellsPath, `${lines.join('\n')}\n`, 'utf8');

  const db = openMetaDb(threadId);
  try {
    const now = Date.now();
    const insertCell = db.prepare(
      `
      INSERT OR REPLACE INTO cells (cell_id, turn_id, line_offset, ts, kind)
      VALUES (?, ?, ?, ?, ?)
    `,
    );

    let lineOffset = startLineOffset;
    let firstCellId = records[0]!.cell_id;
    let lastCellId = records[records.length - 1]!.cell_id;

    for (const record of records) {
      insertCell.run(
        record.cell_id,
        turnId,
        lineOffset,
        record.ts,
        record.kind,
      );
      lineOffset += 1;
    }

    const lastLineOffset = lineOffset - 1;

    const existingBounds = db
      .prepare('SELECT turn_id, cell_count FROM turn_bounds WHERE turn_id = ?')
      .get(turnId) as { turn_id: number; cell_count: number } | undefined;

    if (existingBounds) {
      db.prepare(
        `
        UPDATE turn_bounds
           SET last_cell_id = ?,
               last_line_offset = ?,
               cell_count = cell_count + ?
         WHERE turn_id = ?
      `,
      ).run(lastCellId, lastLineOffset, records.length, turnId);
    } else {
      db.prepare(
        `
        INSERT INTO turn_bounds (
          turn_id, first_cell_id, last_cell_id,
          first_line_offset, last_line_offset, cell_count
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      ).run(
        turnId,
        firstCellId,
        lastCellId,
        startLineOffset,
        lastLineOffset,
        records.length,
      );
    }

    const previewRecord = records.find((record) => record.kind === 'user_message');
    const preview = previewRecord ? previewFromRecord(previewRecord) : null;

    db.prepare(
      `
      UPDATE thread_meta
         SET updated_at = ?,
             turn_count = MAX(turn_count, ?),
             cell_count = cell_count + ?,
             resume_line_offset = ?,
             preview = COALESCE(?, preview)
       WHERE thread_id = ?
    `,
    ).run(now, turnId, records.length, lastLineOffset, preview, threadId);
  } finally {
    db.close();
  }
}

export function loadThreadCells(threadId: string): HistoryCellRecord[] {
  const cellsPath = getCellsPath(threadId);
  if (!existsSync(cellsPath)) return [];

  const content = readFileSync(cellsPath, 'utf8');
  if (!content.trim()) return [];

  const records: HistoryCellRecord[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as HistoryCellRecord);
    } catch {
      // Skip corrupt lines — best-effort load
    }
  }
  return records;
}

export function getThreadMeta(threadId: string): ThreadMeta | null {
  const metaPath = getMetaDbPath(threadId);
  if (!existsSync(metaPath)) return null;

  const db = openMetaDb(threadId);
  try {
    const row = db
      .prepare(
        `
        SELECT thread_id, created_at, updated_at, turn_count, cell_count,
               project_root, preview, resume_line_offset
          FROM thread_meta
         WHERE thread_id = ?
      `,
      )
      .get(threadId) as Record<string, unknown> | undefined;

    return row ? mapThreadMeta(row) : null;
  } finally {
    db.close();
  }
}

export function getTurnBounds(threadId: string, turnId: number): TurnBounds | null {
  const metaPath = getMetaDbPath(threadId);
  if (!existsSync(metaPath)) return null;

  const db = openMetaDb(threadId);
  try {
    const row = db
      .prepare(
        `
        SELECT turn_id, first_cell_id, last_cell_id,
               first_line_offset, last_line_offset, cell_count
          FROM turn_bounds
         WHERE turn_id = ?
      `,
      )
      .get(turnId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      turn_id: Number(row['turn_id'] ?? 0),
      first_cell_id: String(row['first_cell_id'] ?? ''),
      last_cell_id: String(row['last_cell_id'] ?? ''),
      first_line_offset: Number(row['first_line_offset'] ?? 0),
      last_line_offset: Number(row['last_line_offset'] ?? 0),
      cell_count: Number(row['cell_count'] ?? 0),
    };
  } finally {
    db.close();
  }
}

export async function listThreads(options: ListThreadsOptions = {}): Promise<ThreadMeta[]> {
  const threadsRoot = threadsDir();
  if (!existsSync(threadsRoot)) return [];

  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const entries: ThreadMeta[] = [];
  let batchCount = 0;
  const BATCH_SIZE = 20;

  for (const name of readdirSync(threadsRoot)) {
    const dirPath = join(threadsRoot, name);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const meta = getThreadMeta(name);
    if (meta) {
      entries.push(meta);
    } else if (threadStoreExists(name)) {
      const cellCount = loadThreadCells(name).length;
      entries.push({
        thread_id: name,
        created_at: 0,
        updated_at: 0,
        turn_count: 0,
        cell_count: cellCount,
        project_root: null,
        preview: null,
        resume_line_offset: Math.max(0, cellCount - 1),
      });
    }

    if (++batchCount >= BATCH_SIZE) {
      batchCount = 0;
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  entries.sort((a, b) => b.updated_at - a.updated_at);
  return entries.slice(0, limit);
}

/** Rewrite cells.jsonl and rebuild SQLite index from an authoritative cell list. */
export async function replaceThreadRecords(threadId: string, records: HistoryCellRecord[]): Promise<void> {
  ensureThread(threadId);
  writeCellsJsonl(threadId, records);

  const db = openMetaDb(threadId);
  try {
    const existingMeta = db
      .prepare(
        `SELECT parent_thread_id, fork_point_cell_id, project_root, preview, created_at
           FROM thread_meta WHERE thread_id = ?`,
      )
      .get(threadId) as Record<string, unknown> | undefined;

    await syncSqliteIndexFromRecords(db, threadId, records, {
      preserveMeta: {
        created_at: Number(existingMeta?.['created_at'] ?? Date.now()),
        project_root:
          existingMeta?.['project_root'] != null ? String(existingMeta['project_root']) : null,
        preview: existingMeta?.['preview'] != null ? String(existingMeta['preview']) : null,
        parent_thread_id:
          existingMeta?.['parent_thread_id'] != null
            ? String(existingMeta['parent_thread_id'])
            : null,
        fork_point_cell_id:
          existingMeta?.['fork_point_cell_id'] != null
            ? String(existingMeta['fork_point_cell_id'])
            : null,
      },
    });
  } finally {
    db.close();
  }
}

export function setThreadBranchMeta(
  threadId: string,
  parentThreadId: string,
  forkPointCellId: string,
): void {
  const db = openMetaDb(threadId);
  try {
    db.prepare(
      `UPDATE thread_meta
          SET parent_thread_id = ?,
              fork_point_cell_id = ?
        WHERE thread_id = ?`,
    ).run(parentThreadId, forkPointCellId, threadId);
  } finally {
    db.close();
  }
}

export function getThreadBranchMeta(threadId: string): Pick<ThreadMeta, 'thread_id'> & {
  parent_thread_id: string | null;
  fork_point_cell_id: string | null;
} {
  const metaPath = getMetaDbPath(threadId);
  if (!existsSync(metaPath)) {
    return { thread_id: threadId, parent_thread_id: null, fork_point_cell_id: null };
  }

  const db = openMetaDb(threadId);
  try {
    const row = db
      .prepare(
        `SELECT thread_id, parent_thread_id, fork_point_cell_id FROM thread_meta WHERE thread_id = ?`,
      )
      .get(threadId) as Record<string, unknown> | undefined;
    return {
      thread_id: threadId,
      parent_thread_id: row?.['parent_thread_id'] != null ? String(row['parent_thread_id']) : null,
      fork_point_cell_id:
        row?.['fork_point_cell_id'] != null ? String(row['fork_point_cell_id']) : null,
    };
  } finally {
    db.close();
  }
}