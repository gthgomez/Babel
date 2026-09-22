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
 * path, and an admission row is never consulted to allow an action. The run
 * dir's containment is proven (via its deepest existing ancestor) *before* any
 * directory or file is created or chmod'd, the DB is owner-only, and any
 * locked/corrupt/unreadable/future-schema DB fails closed with
 * `ADMISSION_UNAVAILABLE` rather than silently degrading to "allow".
 *
 * Re-read rows are untrusted input: each is shape-validated, and corrupt
 * completeness defaults to incomplete rather than authoritative.
 */

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
  boundAdmissionFacts,
  completeCompleteness,
  DEFAULT_ADMISSION_FACT_BOUNDS,
  incompleteCompleteness,
  mergeCompleteness,
  snapshotAdmissionInput,
  type AdmissionCompletenessV1,
  type AdmissionFactBounds,
  type AdmissionReasonCode,
  type AdmissionRecordV1,
  type AdmissionState,
  type BoundedFactsResult,
  type CommandDigestInput,
  type OutboxRecordV1,
  type OutboxState,
  type OwnerRecordV1,
} from './admissionContracts.js';
import {
  ADMISSION_FAULT_HOOK,
  noteAdmissionStoreClosed,
  noteAdmissionStoreOpened,
  type AdmissionFaultInjectionOptions,
} from './admissionTestHooks.js';

export type { AdmissionFaultPoint } from './admissionTestHooks.js';

const DB_FILENAME = 'runtime-facts.sqlite';

export interface AdmissionStoreOptions extends AdmissionFaultInjectionOptions {
  /** Authorized root; the run dir and DB file must resolve inside it. */
  readonly authorizedRoot: string;
  /** Run directory that will hold the durable admission database. */
  readonly runDir: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly busyTimeoutMs?: number;
}

export interface AdmitCommandInput {
  /** Semantic inputs; also carries threadId/commandId. */
  readonly digestInput: CommandDigestInput;
  readonly ownerGeneration: number;
  readonly ownerToken: string;
  /**
   * Proof of the CURRENT owner token when this admission advances ownership
   * past it (generation > stored generation). Optional so a first/manual
   * admission stays possible, but a caller that holds a lease must present the
   * current token to take over — a superseded holder cannot: its old token no
   * longer matches. Mismatch fails closed with `ADMISSION_STALE_OWNER`.
   */
  readonly previousOwnerToken?: string;
  readonly leaseId?: string;
  readonly baselineId?: string;
  readonly effectClass: ToolEffectClass;
  readonly operationId: string;
  readonly preImageHashes?: Record<string, string>;
  /** Intended post-image, used to detect an already-applied effect after a crash. */
  readonly postImageHashes?: Record<string, string>;
  /**
   * Facts to admit with this command. When supplied they are bounded/validated
   * by `boundAdmissionFacts` inside the transaction, and the resulting
   * completeness is merged with (and can only tighten) `completeness`, so a
   * conflicting/over-cap fact set can never be admitted as `complete`.
   */
  readonly facts?: Iterable<unknown>;
  readonly factBounds?: AdmissionFactBounds;
  /** Caller-claimed completeness; never loosens a bounded-facts result. */
  readonly completeness?: AdmissionCompletenessV1;
}

export type AdmitDecision =
  | { readonly kind: 'admitted'; readonly record: AdmissionRecordV1; readonly outbox: OutboxRecordV1; readonly digest: string }
  | { readonly kind: 'replayed'; readonly record: AdmissionRecordV1; readonly digest: string }
  /** Digest-matching duplicate whose admission is still in flight (no outcome yet). */
  | { readonly kind: 'pending'; readonly record: AdmissionRecordV1; readonly digest: string }
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

/** Read-only admission listing; `skippedCorruptRows` makes silent drops explicit. */
export interface AdmissionListing {
  readonly records: readonly AdmissionRecordV1[];
  readonly skippedCorruptRows: number;
}

export interface AdmissionStore {
  readonly dbPath: string;
  admitCommand(input: AdmitCommandInput): AdmitDecision;
  settleAdmission(input: SettleAdmissionInput): SettleDecision;
  recoverAdmission(input: RecoverAdmissionInput): RecoverDecision;
  readAdmission(threadId: string, commandId: string): AdmissionRecordV1 | null;
  /**
   * Read-only: every admission for a thread, oldest first, plus the number of
   * rows that failed shape validation. A corrupt row is never hidden: the caller
   * must treat `skippedCorruptRows > 0` as an incomplete history.
   */
  listAdmissions(threadId: string): AdmissionListing;
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
    quarantined_json TEXT,
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

// ─── Row validation (untrusted re-read input) ───────────────────────────────

/** Raised when a persisted row cannot be trusted; callers fail closed. */
class AdmissionCorruptRowError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'AdmissionCorruptRowError';
  }
}

const ADMISSION_STATES: ReadonlySet<string> = new Set(['claimed', 'settled', 'aborted', 'indeterminate']);
const OUTBOX_STATES: ReadonlySet<string> = new Set(['intent', 'committed', 'failed', 'indeterminate']);
const EFFECT_CLASSES: ReadonlySet<string> = new Set([
  'read_only',
  'idempotent',
  'reconcilable_mutation',
  'non_idempotent_local_effect',
  'external_side_effect',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAdmissionState(value: unknown): value is AdmissionState {
  return typeof value === 'string' && ADMISSION_STATES.has(value);
}

function isOutboxState(value: unknown): value is OutboxState {
  return typeof value === 'string' && OUTBOX_STATES.has(value);
}

function isEffectClass(value: unknown): value is ToolEffectClass {
  return typeof value === 'string' && EFFECT_CLASSES.has(value);
}

function requireString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AdmissionCorruptRowError(`invalid_${key}`);
  }
  return value;
}

function requireInteger(row: Record<string, unknown>, key: string, min: number): number {
  const raw = row[key];
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < min) throw new AdmissionCorruptRowError(`invalid_${key}`);
  return value;
}

function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function unavailable(detail: string): AdmissionOpenResult {
  return { ok: false, reasonCode: ADMISSION_REASONS.UNAVAILABLE, detail };
}

/**
 * Resolve the run dir and prove containment inside `root` *before* creating or
 * chmod-ing anything. The deepest existing ancestor is realpath'd and checked
 * first, so a caller-supplied path (or symlinked component) that escapes the
 * authorized root is rejected without any out-of-jail side effect. Only then is
 * the remaining (non-existent) tail created under the verified ancestor.
 */
function resolveJailedRunDir(root: string, runDir: string): { ok: true; dir: string } | { ok: false; detail: string } {
  const absolute = resolve(runDir);
  let existing = absolute;
  let guard = 0;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
    guard += 1;
    if (guard > 10_000) return { ok: false, detail: 'run_dir_ancestor_walk_exceeded' };
  }

  let realExisting: string;
  try {
    realExisting = realpathSync(existing);
  } catch (error) {
    return { ok: false, detail: `run_dir_ancestor_unresolvable:${errorText(error)}` };
  }
  if (!isWithin(root, realExisting)) return { ok: false, detail: 'run_dir_outside_authorized_root' };

  const tail = relative(existing, absolute);
  if (tail.startsWith('..') || isAbsolute(tail)) {
    return { ok: false, detail: 'run_dir_outside_authorized_root' };
  }
  const finalDir = resolve(realExisting, tail);
  if (!isWithin(root, finalDir)) return { ok: false, detail: 'run_dir_outside_authorized_root' };

  try {
    mkdirSync(finalDir, { recursive: true, mode: 0o700 });
    chmodSync(finalDir, 0o700);
    const dir = realpathSync(finalDir);
    if (!isWithin(root, dir)) return { ok: false, detail: 'run_dir_outside_authorized_root' };
    return { ok: true, dir };
  } catch (error) {
    return { ok: false, detail: `run_dir_unresolvable:${errorText(error)}` };
  }
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
      // Additive column migration for DBs created before `quarantined_json`.
      const columns = database.prepare('PRAGMA table_info(admission)').all() as Array<{ name?: unknown }>;
      const columnNames = new Set(columns.map((column) => String(column['name'])));
      if (!columnNames.has('quarantined_json')) {
        database.exec('ALTER TABLE admission ADD COLUMN quarantined_json TEXT');
      }
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

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function corruptCompleteness(reason: string): AdmissionCompletenessV1 {
  return incompleteCompleteness({ reasons: [reason], admittedCount: 0, droppedCount: 0 });
}

/**
 * Validate a persisted completeness cell. A missing, unparseable, or internally
 * inconsistent value (claims complete while carrying drops) fails closed to an
 * explicit incomplete record.
 */
function parseCompletenessCell(value: unknown): AdmissionCompletenessV1 {
  const parsed = parseJson(value);
  if (!isRecord(parsed)) return corruptCompleteness('corrupt_completeness');
  const { complete, truncated, reasons, admittedCount, droppedCount, evidenceRefsDropped } = parsed;
  const countsValid =
    typeof admittedCount === 'number' &&
    Number.isInteger(admittedCount) &&
    admittedCount >= 0 &&
    typeof droppedCount === 'number' &&
    Number.isInteger(droppedCount) &&
    droppedCount >= 0 &&
    typeof evidenceRefsDropped === 'number' &&
    Number.isInteger(evidenceRefsDropped) &&
    evidenceRefsDropped >= 0;
  const reasonsValid = Array.isArray(reasons) && reasons.every((reason) => typeof reason === 'string');
  if (typeof complete !== 'boolean' || typeof truncated !== 'boolean' || !countsValid || !reasonsValid) {
    return corruptCompleteness('corrupt_completeness');
  }
  const normalized = [...new Set(reasons as string[])].sort();
  if (complete && (truncated || droppedCount > 0 || evidenceRefsDropped > 0 || normalized.length > 0)) {
    return incompleteCompleteness({
      reasons: [...normalized, 'inconsistent_completeness'],
      admittedCount,
      droppedCount,
      evidenceRefsDropped,
      truncated: true,
    });
  }
  return {
    complete,
    truncated,
    reasons: normalized,
    admittedCount,
    droppedCount,
    evidenceRefsDropped,
  };
}

function parseHashCell(value: unknown): Record<string, string> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new AdmissionCorruptRowError('invalid_hash_cell');
  const parsed = parseJson(value);
  if (!isRecord(parsed)) throw new AdmissionCorruptRowError('invalid_hash_json');
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== 'string') throw new AdmissionCorruptRowError('invalid_hash_entry');
    out[key] = entry;
  }
  return out;
}

function rowToAdmission(row: Record<string, unknown>): AdmissionRecordV1 {
  const state = row['state'];
  if (!isAdmissionState(state)) throw new AdmissionCorruptRowError('invalid_admission_state');
  const outcomeCell = row['outcome_json'];
  let outcome: unknown;
  let hasOutcome = false;
  if (typeof outcomeCell === 'string') {
    try {
      outcome = JSON.parse(outcomeCell) as unknown;
      hasOutcome = true;
    } catch {
      throw new AdmissionCorruptRowError('invalid_outcome_json');
    }
  } else if (outcomeCell !== null && outcomeCell !== undefined) {
    throw new AdmissionCorruptRowError('invalid_outcome_cell');
  }
  return {
    admissionId: requireString(row, 'admission_id'),
    threadId: requireString(row, 'thread_id'),
    commandId: requireString(row, 'command_id'),
    digest: requireString(row, 'digest'),
    ownerGeneration: requireInteger(row, 'owner_generation', 1),
    state,
    ...(hasOutcome ? { outcome } : {}),
    completeness: parseCompletenessCell(row['completeness_json']),
    createdAt: requireString(row, 'created_at'),
    updatedAt: requireString(row, 'updated_at'),
  };
}

function rowToOwner(row: Record<string, unknown>): OwnerRecordV1 {
  return {
    threadId: requireString(row, 'thread_id'),
    generation: requireInteger(row, 'generation', 1),
    token: requireString(row, 'token'),
    ...(typeof row['lease_id'] === 'string' ? { leaseId: row['lease_id'] } : {}),
    ...(typeof row['baseline_id'] === 'string' ? { baselineId: row['baseline_id'] } : {}),
    ...(typeof row['settled_at'] === 'string' ? { settledAt: row['settled_at'] } : {}),
  };
}

function rowToOutbox(row: Record<string, unknown>): OutboxRecordV1 {
  const state = row['state'];
  if (!isOutboxState(state)) throw new AdmissionCorruptRowError('invalid_outbox_state');
  const effectClass = row['effect_class'];
  if (!isEffectClass(effectClass)) throw new AdmissionCorruptRowError('invalid_effect_class');
  const pre = parseHashCell(row['pre_image_json']);
  const post = parseHashCell(row['post_image_json']);
  const error = row['error'];
  return {
    outboxId: requireString(row, 'outbox_id'),
    admissionId: requireString(row, 'admission_id'),
    effectClass,
    operationId: requireString(row, 'operation_id'),
    state,
    ...(pre !== undefined ? { preImageHashes: pre } : {}),
    ...(post !== undefined ? { postImageHashes: post } : {}),
    ...(typeof error === 'string' ? { error } : {}),
  };
}

function safeRowToAdmission(row: Record<string, unknown> | undefined): AdmissionRecordV1 | null {
  if (!row) return null;
  try {
    return rowToAdmission(row);
  } catch {
    return null;
  }
}

function serializeHashes(hashes: Record<string, string> | undefined): string | null {
  if (hashes === undefined) return null;
  return JSON.stringify(hashes);
}

// ─── Per-process handle registry (single owner per DB path) ────────────────
//
// Two production seams may open the same session's store in one process (for
// example a REPL engine and a protocol-host materialization of the same
// thread). A second open must not double-own the SQLite handle: concurrent
// opens share ONE inner store through reference-counted façades, `close()`
// releases this façade's reference, and the handle closes only when the last
// reference is gone. After the final close the registry entry is dropped, so
// a later reopen (crash/restart simulation included) opens fresh.

interface OpenStoreEntry {
  readonly store: AdmissionStore;
  refs: number;
}

const OPEN_STORES = new Map<string, OpenStoreEntry>();

/** Test observability lives in the test-hooks module (see admissionTestHooks). */
function noteStoreOpened(): void {
  noteAdmissionStoreOpened();
}

function noteStoreClosed(): void {
  noteAdmissionStoreClosed();
}

function refCountedStore(inner: AdmissionStore): AdmissionStore {
  let released = false;
  return {
    dbPath: inner.dbPath,
    admitCommand(input) {
      if (released) {
        return {
          kind: 'rejected',
          reasonCode: ADMISSION_REASONS.UNAVAILABLE,
          detail: 'store_closed',
        };
      }
      return inner.admitCommand(input);
    },
    settleAdmission(input) {
      if (released) {
        return { settled: false, reasonCode: ADMISSION_REASONS.UNAVAILABLE, detail: 'store_closed' };
      }
      return inner.settleAdmission(input);
    },
    recoverAdmission(input) {
      if (released) {
        return {
          kind: 'rejected',
          reasonCode: ADMISSION_REASONS.UNAVAILABLE,
          detail: 'store_closed',
        };
      }
      return inner.recoverAdmission(input);
    },
    readAdmission(threadId, commandId) {
      // Fail closed after this façade's close: a released handle proves nothing.
      return released ? null : inner.readAdmission(threadId, commandId);
    },
    listAdmissions(threadId) {
      return released ? { records: [], skippedCorruptRows: 0 } : inner.listAdmissions(threadId);
    },
    readOwner(threadId) {
      return released ? null : inner.readOwner(threadId);
    },
    readOutbox(admissionId) {
      return released ? null : inner.readOutbox(admissionId);
    },
    close(): void {
      if (released) return;
      released = true;
      const entry = OPEN_STORES.get(inner.dbPath);
      if (!entry || entry.store !== inner) return;
      entry.refs -= 1;
      if (entry.refs <= 0) {
        OPEN_STORES.delete(inner.dbPath);
        noteStoreClosed();
        inner.close();
      }
    },
  };
}

/** Open (creating if needed) the durable admission store for one run dir. */
export function openAdmissionStore(options: AdmissionStoreOptions): AdmissionOpenResult {
  let root: string;
  try {
    root = realpathSync(options.authorizedRoot);
  } catch (error) {
    return unavailable(`authorized_root_unresolvable:${errorText(error)}`);
  }

  // Prove containment before creating/chmod-ing anything.
  const jailed = resolveJailedRunDir(root, options.runDir);
  if (!jailed.ok) return unavailable(jailed.detail);
  const dir = jailed.dir;

  const dbPath = join(dir, DB_FILENAME);
  // A second in-process open of the same DB path must not double-own the
  // handle: hand out another reference to the already-open inner store.
  const alreadyOpen = OPEN_STORES.get(dbPath);
  if (alreadyOpen) {
    alreadyOpen.refs += 1;
    return { ok: true, store: refCountedStore(alreadyOpen.store) };
  }
  try {
    // `lstat` (not `exists`) so a dangling symlink counts as present: creating
    // through it would write outside the jail before the realpath check.
    const existing = lstatSync(dbPath, { throwIfNoEntry: false });
    if (!existing) {
      const fd = openSync(dbPath, 'a', 0o600);
      closeSync(fd);
    }
    const realDb = realpathSync(dbPath);
    if (!isWithin(root, realDb)) return unavailable('db_path_outside_authorized_root');
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
  const faultInject = options[ADMISSION_FAULT_HOOK];

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

      // Bound/validate any supplied facts *before* the transaction, then merge
      // their completeness with the caller's claim; the result can only tighten.
      // Facts may be supplied explicitly, or embedded in `payload.facts` (the
      // recon's canonical "command + facts" layout), and both are bounded.
      const payloadFactArray =
        isRecord(digestInput.payload) && Array.isArray(digestInput.payload['facts'])
          ? (digestInput.payload['facts'] as unknown[])
          : undefined;
      const factsInput = input.facts ?? payloadFactArray;
      let bounded: BoundedFactsResult | null = null;
      if (factsInput !== undefined) {
        try {
          bounded = boundAdmissionFacts(factsInput, input.factBounds ?? DEFAULT_ADMISSION_FACT_BOUNDS);
        } catch {
          return {
            kind: 'rejected',
            reasonCode: ADMISSION_REASONS.INVALID_INPUT,
            detail: 'facts could not be bounded',
          };
        }
      }
      const completeness = mergeCompleteness(
        input.completeness ?? completeCompleteness(0),
        bounded ? bounded.completeness : completeCompleteness(0),
      );
      const quarantined = bounded ? bounded.quarantinedFactIds : [];
      const factsSnapshot = bounded ? bounded.facts : null;

      const snapshot = snapshotAdmissionInput(digestInput, factsSnapshot);
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

      db.exec('BEGIN IMMEDIATE');
      let decision: AdmitDecision;
      try {
        const existing = readAdmissionRow(threadId, commandId);
        if (existing) {
          let record: AdmissionRecordV1;
          try {
            record = rowToAdmission(existing);
          } catch {
            db.exec('ROLLBACK');
            return {
              kind: 'rejected',
              reasonCode: ADMISSION_REASONS.UNAVAILABLE,
              detail: 'corrupt_admission_row',
            };
          }
          if (record.digest === digest) {
            db.exec('COMMIT');
            // An in-flight duplicate has no outcome yet; report it distinctly.
            return record.state === 'claimed'
              ? { kind: 'pending', record, digest }
              : { kind: 'replayed', record, digest };
          }
          db.exec('ROLLBACK');
          return {
            kind: 'rejected',
            reasonCode: ADMISSION_REASONS.DIGEST_CONFLICT,
            detail: 'same command id with changed semantic inputs',
          };
        }

        const ownerRow = db.prepare('SELECT generation, token FROM owner WHERE thread_id = ?').get(threadId) as
          | Record<string, unknown>
          | undefined;
        if (ownerRow) {
          let ownerGeneration: number;
          let ownerToken: string;
          try {
            ownerGeneration = requireInteger(ownerRow, 'generation', 1);
            ownerToken = requireString(ownerRow, 'token');
          } catch {
            db.exec('ROLLBACK');
            return { kind: 'rejected', reasonCode: ADMISSION_REASONS.UNAVAILABLE, detail: 'corrupt_owner_row' };
          }
          // A lower generation is genuinely superseded. An equal generation is
          // the same owner and may admit further commands; a different token at
          // the same generation is a conflicting owner and is fenced.
          const superseded =
            input.ownerGeneration < ownerGeneration ||
            (input.ownerGeneration === ownerGeneration && input.ownerToken !== ownerToken);
          if (superseded) {
            db.exec('ROLLBACK');
            return {
              kind: 'rejected',
              reasonCode: ADMISSION_REASONS.STALE_OWNER,
              detail: `generation ${input.ownerGeneration} is superseded by ${ownerGeneration}`,
            };
          }
          // A1/ownership seizure fence: an EXISTING owner may only be advanced
          // by exactly one generation, never seized by an arbitrary larger
          // number. When the caller presents the previous owner token it must
          // be the current one, so a stale holder can never prove takeover.
          if (
            input.ownerGeneration > ownerGeneration &&
            input.ownerGeneration !== ownerGeneration + 1
          ) {
            db.exec('ROLLBACK');
            return {
              kind: 'rejected',
              reasonCode: ADMISSION_REASONS.STALE_OWNER,
              detail: `generation ${input.ownerGeneration} must advance the owner generation ${ownerGeneration} by exactly one`,
            };
          }
          if (
            input.ownerGeneration === ownerGeneration + 1 &&
            input.previousOwnerToken !== undefined &&
            input.previousOwnerToken !== ownerToken
          ) {
            db.exec('ROLLBACK');
            return {
              kind: 'rejected',
              reasonCode: ADMISSION_REASONS.STALE_OWNER,
              detail: 'previous_owner_token_mismatch',
            };
          }
        }

        const admissionId = newId();
        const outboxId = newId();
        db.prepare(
          `INSERT INTO admission
             (admission_id, thread_id, command_id, digest, owner_generation, state, outcome_json,
              completeness_json, input_json, quarantined_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'claimed', NULL, ?, ?, ?, ?, ?)`,
        ).run(
          admissionId,
          threadId,
          commandId,
          digest,
          input.ownerGeneration,
          JSON.stringify(completeness),
          JSON.stringify(snapshot.snapshot),
          quarantined.length > 0 ? JSON.stringify(quarantined) : null,
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
          | Record<string, unknown>
          | undefined;
        let ownerGeneration: number | null = null;
        let ownerToken: string | null = null;
        if (ownerRow) {
          try {
            ownerGeneration = requireInteger(ownerRow, 'generation', 1);
            ownerToken = requireString(ownerRow, 'token');
          } catch {
            db.exec('ROLLBACK');
            return { settled: false, reasonCode: ADMISSION_REASONS.UNAVAILABLE, detail: 'corrupt_owner_row' };
          }
        }
        const ownerMatches =
          ownerGeneration !== null &&
          ownerGeneration === input.ownerGeneration &&
          ownerToken === input.ownerToken;
        // A1: after a generation takeover the superseded owner's *claimed*
        // command must remain settleable — otherwise a gen-N admission would
        // stay `'claimed'` forever once gen N+1 appears. The fence: only a
        // non-success terminal state is allowed, and only for an admission
        // actually claimed under the settling generation (checked below), so a
        // superseded command can never record success under current authority.
        const ownerSuperseded =
          ownerGeneration !== null && input.ownerGeneration < ownerGeneration;
        const supersededSettleAllowed =
          ownerSuperseded && (input.state === 'aborted' || input.state === 'indeterminate');
        if (!ownerMatches && !supersededSettleAllowed) {
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
        let current: AdmissionRecordV1;
        try {
          current = rowToAdmission(admissionRow);
        } catch {
          db.exec('ROLLBACK');
          return { settled: false, reasonCode: ADMISSION_REASONS.UNAVAILABLE, detail: 'corrupt_admission_row' };
        }
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
      const record = safeRowToAdmission(row);
      if (!record) {
        return { kind: 'rejected', reasonCode: ADMISSION_REASONS.UNAVAILABLE, detail: 'corrupt_admission_row' };
      }
      const outboxRow = readOutboxRow(record.admissionId);
      if (!outboxRow) {
        return { kind: 'recovered', record, outbox: null, decision: 'manual_review' };
      }
      let outbox: OutboxRecordV1;
      try {
        outbox = rowToOutbox(outboxRow);
      } catch {
        // A corrupt/unrecognized outbox state must not be read as success.
        return { kind: 'recovered', record, outbox: null, decision: 'manual_review' };
      }
      if (outbox.state !== 'intent') {
        // Only an explicitly committed effect is recovered; any other terminal
        // or unknown state requires manual review.
        return {
          kind: 'recovered',
          record,
          outbox,
          decision: outbox.state === 'committed' ? 'recovered_complete' : 'manual_review',
        };
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
      // A1: a corrupt row fails closed to null (non-authoritative) instead of
      // throwing out of a reader on the owner/checkpoint decision path.
      return safeRowToAdmission(row);
    },

    listAdmissions(threadId): AdmissionListing {
      const rows = db
        .prepare('SELECT * FROM admission WHERE thread_id = ? ORDER BY created_at ASC, admission_id ASC')
        .all(threadId) as Array<Record<string, unknown>>;
      const records: AdmissionRecordV1[] = [];
      let skippedCorruptRows = 0;
      for (const row of rows) {
        const record = safeRowToAdmission(row);
        if (record) records.push(record);
        else skippedCorruptRows += 1;
      }
      return { records, skippedCorruptRows };
    },

    readOwner(threadId): OwnerRecordV1 | null {
      const row = db.prepare('SELECT * FROM owner WHERE thread_id = ?').get(threadId) as
        | Record<string, unknown>
        | undefined;
      if (!row) return null;
      // A1: a corrupt owner row fails closed to null — `owner_missing` on the
      // P11 path — instead of throwing out of `currentP11Owner`/hydration.
      try {
        return rowToOwner(row);
      } catch {
        return null;
      }
    },

    readOutbox(admissionId): OutboxRecordV1 | null {
      return readOutboxById(admissionId);
    },

    close(): void {
      db.close();
    },
  };

  OPEN_STORES.set(dbPath, { store, refs: 1 });
  noteStoreOpened();
  return { ok: true, store: refCountedStore(store) };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return String(error).slice(0, 200);
}
