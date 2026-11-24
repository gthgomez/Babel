import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type CommandJournalState = 'admitted' | 'settled' | 'unknown';

export interface NativeCommandRecord {
  commandId: string;
  fingerprint: string;
  principalId: string;
  projectId: string;
  threadId: string | null;
  hostInstanceId: string;
  registrationGeneration: number;
  state: CommandJournalState;
  resultJson: string | null;
  updatedAt: number;
}

export type CommandReservation =
  | { ok: true; created: boolean; record: NativeCommandRecord }
  | { ok: false; reason: 'command_fingerprint_conflict' };

/**
 * Durable admission ledger. Callers must reserve before attempting a native
 * effect; an admitted row recovered under another host instance is ambiguous,
 * never an instruction to replay the effect.
 */
export class NativeCommandJournal {
  private readonly db: DatabaseSync;

  constructor(
    private readonly path: string,
    options: { hostInstanceId: string; protectStoreDirectory: (directory: string) => void },
  ) {
    if (!options.hostInstanceId) throw new Error('host instance identity is required');
    mkdirSync(dirname(path), { recursive: true });
    // The owner-only directory boundary must be installed before SQLite can
    // create its database, WAL or shared-memory sidecars.
    options.protectStoreDirectory(dirname(path));
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=10000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS native_command_journal (
      command_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      host_instance_id TEXT NOT NULL,
      registration_generation INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('admitted','settled','unknown')),
      result_json TEXT,
      updated_at INTEGER NOT NULL
    );`);
    this.db.prepare(`UPDATE native_command_journal SET state='unknown', updated_at=?
      WHERE state='admitted' AND host_instance_id<>?`).run(Date.now(), options.hostInstanceId);
  }

  reserve(input: {
    commandId: string;
    principalId: string;
    projectId: string;
    threadId?: string;
    hostInstanceId: string;
    registrationGeneration: number;
    payload: unknown;
  }): CommandReservation {
    if (!input.commandId || !input.principalId || !input.projectId || !input.hostInstanceId ||
        !Number.isSafeInteger(input.registrationGeneration) || input.registrationGeneration < 1) {
      throw new Error('invalid command admission identity');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(input.payload)).digest('hex');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM native_command_journal WHERE command_id=?').get(input.commandId) as Record<string, unknown> | undefined;
      if (existing) {
        if (existing['fingerprint'] !== fingerprint || existing['principal_id'] !== input.principalId ||
            existing['project_id'] !== input.projectId) {
          return { ok: false, reason: 'command_fingerprint_conflict' };
        }
        return { ok: true, created: false, record: this.decode(existing) };
      }
      const updatedAt = Date.now();
      this.db.prepare(`INSERT INTO native_command_journal
        (command_id,fingerprint,principal_id,project_id,thread_id,host_instance_id,registration_generation,state,result_json,updated_at)
        VALUES (?,?,?,?,?,?,?,'admitted',NULL,?)`).run(
        input.commandId, fingerprint, input.principalId, input.projectId, input.threadId ?? null,
        input.hostInstanceId, input.registrationGeneration, updatedAt,
      );
      return {
        ok: true, created: true,
        record: { commandId: input.commandId, fingerprint, principalId: input.principalId, projectId: input.projectId,
          threadId: input.threadId ?? null, hostInstanceId: input.hostInstanceId,
          registrationGeneration: input.registrationGeneration, state: 'admitted', resultJson: null, updatedAt },
      };
    });
  }

  settle(input: { commandId: string; principalId: string; result: unknown; threadId?: string }): boolean {
    const resultJson = JSON.stringify(input.result);
    const update = this.db.prepare(`UPDATE native_command_journal SET state='settled',result_json=?,thread_id=COALESCE(?,thread_id),updated_at=?
      WHERE command_id=? AND principal_id=? AND state='admitted'`)
      .run(resultJson, input.threadId ?? null, Date.now(), input.commandId, input.principalId);
    return Number(update.changes) === 1;
  }

  markUnknown(input: { commandId: string; principalId: string }): boolean {
    const update = this.db.prepare(`UPDATE native_command_journal SET state='unknown',updated_at=?
      WHERE command_id=? AND principal_id=? AND state='admitted'`)
      .run(Date.now(), input.commandId, input.principalId);
    return Number(update.changes) === 1;
  }

  lookup(input: { commandId: string; principalId: string; projectId: string }): NativeCommandRecord | null {
    const row = this.db.prepare(`SELECT * FROM native_command_journal
      WHERE command_id=? AND principal_id=? AND project_id=?`).get(
      input.commandId, input.principalId, input.projectId,
    ) as Record<string, unknown> | undefined;
    return row ? this.decode(row) : null;
  }

  close(): void { this.db.close(); }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private decode(row: Record<string, unknown>): NativeCommandRecord {
    return {
      commandId: String(row['command_id']), fingerprint: String(row['fingerprint']),
      principalId: String(row['principal_id']), projectId: String(row['project_id']),
      threadId: typeof row['thread_id'] === 'string' ? row['thread_id'] : null,
      hostInstanceId: String(row['host_instance_id']), registrationGeneration: Number(row['registration_generation']),
      state: row['state'] as CommandJournalState,
      resultJson: typeof row['result_json'] === 'string' ? row['result_json'] : null,
      updatedAt: Number(row['updated_at']),
    };
  }
}
