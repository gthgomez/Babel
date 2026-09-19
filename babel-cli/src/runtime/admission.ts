/**
 * P05 durable command admission.
 *
 * One SQLite database per authorized run directory records, atomically:
 *   - the admission itself (with a canonical semantic digest),
 *   - the current thread owner `(generation, token)`, and
 *   - an outbox row describing the staged side effect.
 *
 * The store is a *record*, never an authority source. It never sits on the
 * permission-decision path: permission remains solely the authority PDP/wire
 * path, and an admission row is never consulted to allow an action. The DB
 * lives under a realpath-verified authorized root with owner-only permissions,
 * and any locked/corrupt/unreadable/future-schema DB fails closed with
 * `ADMISSION_UNAVAILABLE` rather than silently degrading to "allow".
 *
 * Re-read rows are untrusted input and are re-validated through the same
 * contracts boundary before use.
 */

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ToolEffectClass } from '../executor/contracts.js';
import { toImmutableJson } from './canonical.js';
import {
  reconcileInterruptedEffect,
  type EffectReconciliationDecision,
} from '../executor/effectLedger.js';
import {
  ADMISSION_REASONS,
  ADMISSION_SCHEMA_VERSION,
  completeCompleteness,
  snapshotAdmissionInput,
  type AdmissionCompletenessV1,
  type AdmissionReasonCode,
  type AdmissionRecordV1,
  type AdmissionState,
  type CommandDigestInput,
  type OutboxRecordV1,
  type OutboxState,
  type OwnerRecordV1,
} from './admissionContracts.js';

const DB_FILENAME = 'runtime-facts.sqlite';

/** Test-only transaction-boundary fault seam. Never set in production. */
export type AdmissionFaultPoint =
  | 'before_admission_commit'
  | 'after_admission_commit'
  | 'before_terminal_commit';

export interface AdmissionStoreOptions {
  /** Authorized root; the run dir and DB file must resolve inside it. */
  readonly authorizedRoot: string;
  /** Run directory that will hold the durable admission database. */
  readonly runDir: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly busyTimeoutMs?: number;
  /** Test-only: throw at a transaction boundary to simulate a crash. */
  readonly faultInject?: (point: AdmissionFaultPoint) => void;
}

export interface AdmitCommandInput {
  /** Semantic inputs; also carries threadId/commandId. */
  readonly digestInput: CommandDigestInput;
  readonly ownerGeneration: number;
  readonly ownerToken: string;
  readonly leaseId?: string;
  readonly baselineId?: string;
  readonly effectClass: ToolEffectClass;
  readonly operationId: string;
  readonly preImageHashes?: Record<string, string>;
  /** Intended post-image, used to detect an already-applied effect after a crash. */
  readonly postImageHashes?: Record<string, string>;
  readonly completeness?: AdmissionCompletenessV1;
}

export type AdmitDecision =
  | { readonly kind: 'admitted'; readonly record: AdmissionRecordV1; readonly outbox: OutboxRecordV1; readonly digest: string }
  | { readonly kind: 'replayed'; readonly record: AdmissionRecordV1; readonly digest: string }
  | { readonly kind: 'rejected'; readonly reasonCode: AdmissionReasonCode; readonly detail?: string };

export interface SettleAdmissionInput {
  readonly threadId: string;
  readonly commandId: string;
  readonly ownerGeneration: number;
  readonly ownerToken: string;
  readonly state: Exclude<AdmissionState, 'claimed'>;
  readonly outcome?: unknown;
  readonly completeness?: AdmissionCompletenessV1;
  readonly outbox?: {
    readonly state: OutboxState;
    readonly postImageHashes?: Record<string, string>;
    readonly error?: string;
  };
}

export type SettleDecision =
  | { readonly settled: true; readonly replayed: boolean; readonly record: AdmissionRecordV1; readonly outbox: OutboxRecordV1 | null }
  | { readonly settled: false; readonly reasonCode: AdmissionReasonCode; readonly detail?: string };

export interface RecoverAdmissionInput {
  readonly threadId: string;
  readonly commandId: string;
  readonly currentImageHashes?: Record<string, string>;
}

export type RecoverDecision =
  | {
      readonly kind: 'recovered';
      readonly record: AdmissionRecordV1;
      readonly outbox: OutboxRecordV1 | null;
      readonly decision: EffectReconciliationDecision;
    }
  | { readonly kind: 'rejected'; readonly reasonCode: AdmissionReasonCode; readonly detail?: string };

export interface AdmissionStore {
  readonly dbPath: string;
  admitCommand(input: AdmitCommandInput): AdmitDecision;
  settleAdmission(input: SettleAdmissionInput): SettleDecision;
  recoverAdmission(input: RecoverAdmissionInput): RecoverDecision;
  readAdmission(threadId: string, commandId: string): AdmissionRecordV1 | null;
  readOwner(threadId: string): OwnerRecordV1 | null;
  readOutbox(admissionId: string): OutboxRecordV1 | null;
  close(): void;
}

export type AdmissionOpenResult =
  | { readonly ok: true; readonly store: AdmissionStore }
  | { readonly ok: false; readonly reasonCode: AdmissionReasonCode; readonly detail: string };

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS admission (
    admission_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    owner_generation INTEGER NOT NULL,
    state TEXT NOT NULL,
    outcome_json TEXT,
    completeness_json TEXT NOT NULL,
    input_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(thread_id, command_id)
  );
  CREATE TABLE IF NOT EXISTS owner (
    thread_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL,
    token TEXT NOT NULL,
    lease_id TEXT,
    baseline_id TEXT,
    settled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS outbox (
    outbox_id TEXT PRIMARY KEY,
    admission_id TEXT NOT NULL,
    effect_class TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    state TEXT NOT NULL,
    pre_image_json TEXT,
    post_image_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_admission ON outbox(admission_id);
`;

function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function unavailable(detail: string): AdmissionOpenResult {
  return { ok: false, reasonCode: ADMISSION_REASONS.UNAVAILABLE, detail };
}

type OpenDatabaseResult =
  | { readonly ok: true; readonly database: DatabaseSync }
  | { readonly ok: false; readonly detail: string };

/**
 * Open and migrate the admission DB. Any failure returns an explicit detail so
 * the caller can fail closed; a future `user_version` is never entered.
 */
function openAdmissionDatabase(dbPath: string, busyTimeoutMs: number): OpenDatabaseResult {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(dbPath);
    database.exec('PRAGMA journal_mode=WAL');
    database.exec('PRAGMA synchronous=NORMAL');
    database.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(busyTimeoutMs))}`);
    const versionRow = database.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
    const version = Number(versionRow?.['user_version'] ?? 0);
    if (version > ADMISSION_SCHEMA_VERSION) {
      database.close();
      return { ok: false, detail: `future_schema:${version}` };
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(SCHEMA_SQL);
      database.exec(`PRAGMA user_version = ${ADMISSION_SCHEMA_VERSION}`);
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      database.close();
      return { ok: false, detail: `schema_init_failed:${errorText(error)}` };
    }
    return { ok: true, database };
  } catch (error) {
    if (database) {
      try {
        database.close();
      } catch {
        /* ignore */
      }
    }
    return { ok: false, detail: errorText(error) };
  }
}

function parseJson<T>(text: unknown): T | undefined {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function rowToAdmission(row: Record<string, unknown>): AdmissionRecordV1 {
  const outcomeJson = row['outcome_json'];
  const outcome = typeof outcomeJson === 'string' ? parseJson<unknown>(outcomeJson) : undefined;
  const completeness =
    parseJson<AdmissionCompletenessV1>(row['completeness_json']) ?? completeCompleteness(0);
  return {
    admissionId: String(row['admission_id']),
    threadId: String(row['thread_id']),
    commandId: String(row['command_id']),
    digest: String(row['digest']),
    ownerGeneration: Number(row['owner_generation']),
    state: String(row['state']) as AdmissionState,
    ...(outcome !== undefined ? { outcome } : {}),
    completeness,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

function rowToOwner(row: Record<string, unknown>): OwnerRecordV1 {
  return {
    threadId: String(row['thread_id']),
    generation: Number(row['generation']),
    token: String(row['token']),
    ...(row['lease_id'] !== null && row['lease_id'] !== undefined ? { leaseId: String(row['lease_id']) } : {}),
    ...(row['baseline_id'] !== null && row['baseline_id'] !== undefined
      ? { baselineId: String(row['baseline_id']) }
      : {}),
    ...(row['settled_at'] !== null && row['settled_at'] !== undefined ? { settledAt: String(row['settled_at']) } : {}),
  };
}

function rowToOutbox(row: Record<string, unknown>): OutboxRecordV1 {
  const pre = parseJson<Record<string, string>>(row['pre_image_json']);
  const post = parseJson<Record<string, string>>(row['post_image_json']);
  const error = row['error'];
  return {
    outboxId: String(row['outbox_id']),
    admissionId: String(row['admission_id']),
    effectClass: String(row['effect_class']) as ToolEffectClass,
    operationId: String(row['operation_id']),
    state: String(row['state']) as OutboxState,
    ...(pre !== undefined ? { preImageHashes: pre } : {}),
    ...(post !== undefined ? { postImageHashes: post } : {}),
    ...(typeof error === 'string' ? { error } : {}),
  };
}

function serializeHashes(hashes: Record<string, string> | undefined): string | null {
  if (hashes === undefined) return null;
  return JSON.stringify(hashes);
}

/** Open (creating if needed) the durable admission store for one run dir. */
export function openAdmissionStore(options: AdmissionStoreOptions): AdmissionOpenResult {
  let resolved: { root: string; dir: string };
  try {
    const root = realpathSync(options.authorizedRoot);
    mkdirSync(options.runDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(options.runDir, 0o700);
    } catch {
      /* best effort; containment is the security boundary */
    }
    const dir = realpathSync(options.runDir);
    if (!isWithin(root, dir)) return unavailable('run_dir_outside_authorized_root');
    resolved = { root, dir };
  } catch (error) {
    return unavailable(`run_dir_unresolvable:${errorText(error)}`);
  }

  const dbPath = join(resolved.dir, DB_FILENAME);
  try {
    if (!existsSync(dbPath)) {
      const fd = openSync(dbPath, 'a', 0o600);
      closeSync(fd);
    }
    const realDb = realpathSync(dbPath);
    if (!isWithin(resolved.root, realDb)) return unavailable('db_path_outside_authorized_root');
    // Harden only after the path is proven inside the authorized root, so a
    // symlink cannot be used to chmod a file outside the jail.
    chmodSync(realDb, 0o600);
  } catch (error) {
    return unavailable(`db_path_unavailable:${errorText(error)}`);
  }

  const opened = openAdmissionDatabase(dbPath, options.busyTimeoutMs ?? 10_000);
  if (!opened.ok) return unavailable(`db_unavailable:${opened.detail}`);
  const db = opened.database;

  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const faultInject = options.faultInject;

  const readAdmissionRow = (threadId: string, commandId: string): Record<string, unknown> | undefined =>
    db.prepare('SELECT * FROM admission WHERE thread_id = ? AND command_id = ?').get(threadId, commandId) as
      | Record<string, unknown>
      | undefined;

  const readOutboxRow = (admissionId: string): Record<string, unknown> | undefined =>
    db
      .prepare('SELECT * FROM outbox WHERE admission_id = ? ORDER BY created_at DESC, outbox_id DESC LIMIT 1')
      .get(admissionId) as Record<string, unknown> | undefined;

  const readOutboxById = (admissionId: string): OutboxRecordV1 | null => {
    const row = readOutboxRow(admissionId);
    return row ? rowToOutbox(row) : null;
  };

  const store: AdmissionStore = {
    dbPath,

    admitCommand(input): AdmitDecision {
      const { digestInput } = input;
      if (
        !Number.isInteger(input.ownerGeneration) ||
        input.ownerGeneration < 1 ||
        typeof input.ownerToken !== 'string' ||
        input.ownerToken.length === 0
      ) {
        return {
          kind: 'rejected',
          reasonCode: ADMISSION_REASONS.INVALID_INPUT,
          detail: 'owner generation/token must be a positive integer and non-empty string',
        };
      }
      const snapshot = snapshotAdmissionInput(digestInput);
      if (!snapshot.ok) {
        return {
          kind: 'rejected',
          reasonCode: ADMISSION_REASONS.DIGEST_UNENCODABLE,
          detail: 'semantic inputs are not canonically encodable',
        };
      }
      const { digest } = snapshot;
      const threadId = digestInput.threadId;
      const commandId = digestInput.commandId;
      const nowIso = now().toISOString();
      const completeness = input.completeness ?? completeCompleteness(0);

      db.exec('BEGIN IMMEDIATE');
      let decision: AdmitDecision;
      try {
        const existing = readAdmissionRow(threadId, commandId);
        if (existing) {
          const record = rowToAdmission(existing);
          if (record.digest === digest) {
            db.exec('COMMIT');
            return { kind: 'replayed', record, digest };
          }
          db.exec('ROLLBACK');
          return {
            kind: 'rejected',
            reasonCode: ADMISSION_REASONS.DIGEST_CONFLICT,
            detail: 'same command id with changed semantic inputs',
          };
        }

        const ownerRow = db.prepare('SELECT generation, token FROM owner WHERE thread_id = ?').get(threadId) as
          | { generation: unknown; token: unknown }
          | undefined;
        if (ownerRow && input.ownerGeneration <= Number(ownerRow.generation)) {
          db.exec('ROLLBACK');
          return {
            kind: 'rejected',
            reasonCode: ADMISSION_REASONS.STALE_OWNER,
            detail: `generation ${input.ownerGeneration} does not supersede ${String(ownerRow.generation)}`,
          };
        }

        const admissionId = newId();
        const outboxId = newId();
        db.prepare(
          `INSERT INTO admission
             (admission_id, thread_id, command_id, digest, owner_generation, state, outcome_json,
              completeness_json, input_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'claimed', NULL, ?, ?, ?, ?)`,
        ).run(
          admissionId,
          threadId,
          commandId,
          digest,
          input.ownerGeneration,
          JSON.stringify(completeness),
          JSON.stringify(snapshot.snapshot),
          nowIso,
          nowIso,
        );
        db.prepare(
          `INSERT INTO owner (thread_id, generation, token, lease_id, baseline_id, settled_at)
           VALUES (?, ?, ?, ?, ?, NULL)
           ON CONFLICT(thread_id) DO UPDATE SET
             generation = excluded.generation,
             token = excluded.token,
             lease_id = excluded.lease_id,
             baseline_id = excluded.baseline_id,
             settled_at = NULL`,
        ).run(
          threadId,
          input.ownerGeneration,
          input.ownerToken,
          input.leaseId ?? null,
          input.baselineId ?? null,
        );
        db.prepare(
          `INSERT INTO outbox
             (outbox_id, admission_id, effect_class, operation_id, state, pre_image_json,
              post_image_json, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'intent', ?, ?, NULL, ?, ?)`,
        ).run(
          outboxId,
          admissionId,
          input.effectClass,
          input.operationId,
          serializeHashes(input.preImageHashes),
          serializeHashes(input.postImageHashes),
          nowIso,
          nowIso,
        );

        faultInject?.('before_admission_commit');
        db.exec('COMMIT');
        faultInject?.('after_admission_commit');

        const record: AdmissionRecordV1 = {
          admissionId,
          threadId,
          commandId,
          digest,
          ownerGeneration: input.ownerGeneration,
          state: 'claimed',
          completeness,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        const outbox: OutboxRecordV1 = {
          outboxId,
          admissionId,
          effectClass: input.effectClass,
          operationId: input.operationId,
          state: 'intent',
          ...(input.preImageHashes !== undefined ? { preImageHashes: { ...input.preImageHashes } } : {}),
          ...(input.postImageHashes !== undefined ? { postImageHashes: { ...input.postImageHashes } } : {}),
        };
        decision = { kind: 'admitted', record, outbox, digest };
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* transaction already ended (post-commit fault) */
        }
        throw error;
      }
      return decision;
    },

    settleAdmission(input): SettleDecision {
      let outcomeJson: string | null = null;
      if (input.outcome !== undefined) {
        // Never persist a live object: snapshot the outcome to immutable JSON.
        const cloned = toImmutableJson(input.outcome);
        if (!cloned.ok) {
          return { settled: false, reasonCode: ADMISSION_REASONS.INVALID_INPUT, detail: 'outcome_not_serializable' };
        }
        outcomeJson = JSON.stringify(cloned.value);
      }

      db.exec('BEGIN IMMEDIATE');
      try {
        const ownerRow = db.prepare('SELECT generation, token FROM owner WHERE thread_id = ?').get(input.threadId) as
          | { generation: unknown; token: unknown }
          | undefined;
        if (
          !ownerRow ||
          Number(ownerRow.generation) !== input.ownerGeneration ||
          String(ownerRow.token) !== input.ownerToken
        ) {
          db.exec('ROLLBACK');
          return {
            settled: false,
            reasonCode: ADMISSION_REASONS.STALE_OWNER,
            detail: 'owner generation/token mismatch',
          };
        }

        const admissionRow = readAdmissionRow(input.threadId, input.commandId);
        if (!admissionRow) {
          db.exec('ROLLBACK');
          return { settled: false, reasonCode: ADMISSION_REASONS.NOT_FOUND };
        }
        const current = rowToAdmission(admissionRow);
        if (current.ownerGeneration !== input.ownerGeneration) {
          db.exec('ROLLBACK');
          return {
            settled: false,
            reasonCode: ADMISSION_REASONS.STALE_OWNER,
            detail: 'admission owner generation mismatch',
          };
        }
        if (current.state !== 'claimed') {
          const storedOutcome = JSON.stringify(current.outcome ?? null);
          const matches = current.state === input.state && storedOutcome === outcomeJson;
          db.exec('ROLLBACK');
          if (matches) {
            return { settled: true, replayed: true, record: current, outbox: readOutboxById(current.admissionId) };
          }
          return { settled: false, reasonCode: ADMISSION_REASONS.ALREADY_SETTLED };
        }

        const nowIso = now().toISOString();
        const completeness = input.completeness ?? current.completeness;
        const update = db
          .prepare(
            `UPDATE admission
               SET state = ?, outcome_json = ?, completeness_json = ?, updated_at = ?
             WHERE admission_id = ? AND owner_generation = ? AND state = 'claimed'`,
          )
          .run(
            input.state,
            outcomeJson,
            JSON.stringify(completeness),
            nowIso,
            current.admissionId,
            input.ownerGeneration,
          );
        if (Number(update.changes) === 0) {
          db.exec('ROLLBACK');
          return { settled: false, reasonCode: ADMISSION_REASONS.STALE_OWNER };
        }

        if (input.outbox) {
          db.prepare(
            `UPDATE outbox
               SET state = ?, post_image_json = COALESCE(?, post_image_json), error = ?, updated_at = ?
             WHERE admission_id = ? AND state = 'intent'`,
          ).run(
            input.outbox.state,
            serializeHashes(input.outbox.postImageHashes),
            input.outbox.error ?? null,
            nowIso,
            current.admissionId,
          );
        }
        db.prepare(
          `UPDATE owner SET settled_at = ? WHERE thread_id = ? AND generation = ? AND token = ?`,
        ).run(nowIso, input.threadId, input.ownerGeneration, input.ownerToken);

        faultInject?.('before_terminal_commit');
        db.exec('COMMIT');

        const settledRow = readAdmissionRow(input.threadId, input.commandId);
        return {
          settled: true,
          replayed: false,
          record: settledRow ? rowToAdmission(settledRow) : current,
          outbox: readOutboxById(current.admissionId),
        };
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw error;
      }
    },

    recoverAdmission(input): RecoverDecision {
      const row = readAdmissionRow(input.threadId, input.commandId);
      if (!row) return { kind: 'rejected', reasonCode: ADMISSION_REASONS.NOT_FOUND };
      const record = rowToAdmission(row);
      const outboxRow = readOutboxRow(record.admissionId);
      if (!outboxRow) {
        return { kind: 'recovered', record, outbox: null, decision: 'manual_review' };
      }
      const outbox = rowToOutbox(outboxRow);
      if (outbox.state !== 'intent') {
        return { kind: 'recovered', record, outbox, decision: 'recovered_complete' };
      }
      const decision = reconcileInterruptedEffect(
        {
          effectClass: outbox.effectClass,
          preImageHashes: outbox.preImageHashes ?? {},
          ...(outbox.postImageHashes !== undefined ? { postImageHashes: outbox.postImageHashes } : {}),
        },
        input.currentImageHashes ?? {},
      );
      return { kind: 'recovered', record, outbox, decision };
    },

    readAdmission(threadId, commandId): AdmissionRecordV1 | null {
      const row = readAdmissionRow(threadId, commandId);
      return row ? rowToAdmission(row) : null;
    },

    readOwner(threadId): OwnerRecordV1 | null {
      const row = db.prepare('SELECT * FROM owner WHERE thread_id = ?').get(threadId) as
        | Record<string, unknown>
        | undefined;
      return row ? rowToOwner(row) : null;
    },

    readOutbox(admissionId): OutboxRecordV1 | null {
      return readOutboxById(admissionId);
    },

    close(): void {
      db.close();
    },
  };

  return { ok: true, store };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return String(error).slice(0, 200);
}
