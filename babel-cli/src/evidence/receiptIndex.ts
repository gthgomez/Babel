/**
 * P07 — durable, read-only receipt index (ADR-007).
 *
 * Existing receipts keep their existing identities; this index only *stores
 * and looks them up*. It never mints, regenerates, downgrades, or rewrites a
 * receipt, and it is not a second authority: callers must still re-check
 * staleness and revision binding through the existing mechanisms.
 *
 * Durability: entries are persisted to a single canonical JSON document so a
 * lookup survives a host restart. A missing file opens as an empty index; a
 * corrupt file opens as an *inconsistent* index whose lookups return explicit
 * `unavailable` instead of silently dropping receipts.
 *
 * Single-writer ownership: the index rewrites the whole document on `record`,
 * so exactly one process/owner may write a given index directory. Lookups are
 * read-only and never regenerate evidence; concurrent writers are
 * last-writer-wins and are not supported.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

import { canonicalJson, sha256Canonical } from '../acceptance/canonical.js';

export const RECEIPT_INDEX_SCHEMA_VERSION = 1 as const;
export const RECEIPT_INDEX_KIND = 'receipt_index_v1' as const;
export const RECEIPT_INDEX_FILENAME = 'receipt-index.v1.json' as const;

/** Kinds of existing receipt objects the index can hold. */
export type ReceiptKind =
  | 'verifier_receipt'
  | 'execution_receipt'
  | 'completion_decision'
  | 'legacy_receipt';

export const RECEIPT_KINDS: readonly ReceiptKind[] = [
  'verifier_receipt',
  'execution_receipt',
  'completion_decision',
  'legacy_receipt',
];

export interface ReceiptIndexRecordV1 {
  schema_version: typeof RECEIPT_INDEX_SCHEMA_VERSION;
  receipt_id: string;
  kind: ReceiptKind;
  /** Frozen copy of the existing receipt; never regenerated. */
  payload: unknown;
  recorded_at: string;
  /** sha256 over `payload`, so a conflicting re-record is detectable. */
  content_hash: string;
}

export interface ReceiptIndexDocumentV1 {
  schema_version: typeof RECEIPT_INDEX_SCHEMA_VERSION;
  kind: typeof RECEIPT_INDEX_KIND;
  entries: ReceiptIndexRecordV1[];
  state_hash: string;
}

export type ReceiptUnavailableReason =
  | 'not_recorded'
  | 'index_inconsistent';

export type ReceiptLookupResult =
  | { status: 'available'; receipt: ReceiptIndexRecordV1 }
  | {
      status: 'unavailable';
      receipt_id: string;
      reason: ReceiptUnavailableReason;
      detail?: string;
    };

export interface ReceiptIndexStatus {
  consistent: boolean;
  reasons: string[];
  size: number;
  file_path: string;
}

export type ReceiptIndexRecordResult =
  | {
      ok: true;
      record: ReceiptIndexRecordV1;
      created: boolean;
    }
  | {
      ok: false;
      reason:
        | 'index_inconsistent'
        | 'conflicting_receipt_identity'
        | 'invalid_receipt';
      detail?: string;
    };

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const recordSchema = z
  .object({
    schema_version: z.literal(RECEIPT_INDEX_SCHEMA_VERSION),
    receipt_id: z.string().trim().min(1),
    kind: z.enum([
      'verifier_receipt',
      'execution_receipt',
      'completion_decision',
      'legacy_receipt',
    ]),
    payload: z.unknown(),
    recorded_at: z.string().min(1),
    content_hash: sha256,
  })
  .strict();

const documentSchema = z
  .object({
    schema_version: z.literal(RECEIPT_INDEX_SCHEMA_VERSION),
    kind: z.literal(RECEIPT_INDEX_KIND),
    entries: z.array(recordSchema),
    state_hash: sha256,
  })
  .strict();

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Classify an existing receipt from its shape. Classification is descriptive
 * only; it never adds fields or authority to the stored payload.
 */
export function classifyReceiptKind(payload: unknown): ReceiptKind {
  const record = asRecord(payload);
  if (!record) return 'legacy_receipt';
  if (record['boundRevision'] !== undefined) return 'verifier_receipt';
  if (
    record['finalOutcome'] !== undefined &&
    record['requestedOutcome'] !== undefined
  )
    return 'completion_decision';
  if (
    record['operationId'] !== undefined ||
    record['operation_id'] !== undefined ||
    (record['receiptId'] !== undefined && record['status'] !== undefined)
  )
    return 'execution_receipt';
  return 'legacy_receipt';
}

/** Freeze a stored record so callers cannot mutate indexed evidence in place. */
function freezeRecord(record: ReceiptIndexRecordV1): ReceiptIndexRecordV1 {
  return Object.freeze({
    ...record,
    payload:
      typeof record.payload === 'object' && record.payload !== null
        ? Object.freeze(record.payload)
        : record.payload,
  }) as ReceiptIndexRecordV1;
}

function bodyRecord(
  input: {
    receipt_id: string;
    kind: ReceiptKind;
    payload: unknown;
    recorded_at?: string;
  },
): ReceiptIndexRecordV1 {
  const receipt_id = input.receipt_id;
  if (typeof receipt_id !== 'string' || receipt_id.trim().length === 0)
    throw new Error('Receipt id must be a non-empty string.');
  const content_hash = sha256Canonical(input.payload);
  return {
    schema_version: RECEIPT_INDEX_SCHEMA_VERSION,
    receipt_id: receipt_id.trim(),
    kind: input.kind,
    payload: input.payload,
    recorded_at: input.recorded_at ?? new Date().toISOString(),
    content_hash,
  };
}

/**
 * Durable read-only receipt index. Construct with `ReceiptIndex.open`.
 * Persistence is content-addressed per `receipt_id`; a conflicting payload for
 * an existing identity is refused rather than overwritten.
 */
export class ReceiptIndex {
  private readonly filePath: string;
  private readonly records: Map<string, ReceiptIndexRecordV1>;
  private readonly consistent: boolean;
  private readonly inconsistentReasons: string[];

  private constructor(input: {
    filePath: string;
    records: ReceiptIndexRecordV1[];
    reasons: string[];
  }) {
    this.filePath = input.filePath;
    this.records = new Map(
      input.records.map((record) => [record.receipt_id, freezeRecord(record)]),
    );
    this.inconsistentReasons = [...input.reasons];
    this.consistent = input.reasons.length === 0;
  }

  /** Open (or create on first write) an index rooted at `directory`. */
  static open(input: { directory: string }): ReceiptIndex {
    const filePath = path.join(input.directory, RECEIPT_INDEX_FILENAME);
    const loaded = loadDocument(filePath);
    return new ReceiptIndex({
      filePath,
      records: loaded.records,
      reasons: loaded.reasons,
    });
  }

  status(): ReceiptIndexStatus {
    return {
      consistent: this.consistent,
      reasons: [...this.inconsistentReasons],
      size: this.consistent ? this.records.size : 0,
      file_path: this.filePath,
    };
  }

  /** Record an existing receipt. Never mutates or regenerates its payload. */
  record(input: {
    receipt_id: string;
    kind?: ReceiptKind;
    payload: unknown;
    recorded_at?: string;
  }): ReceiptIndexRecordResult {
    if (!this.consistent)
      return { ok: false, reason: 'index_inconsistent' };
    let candidate: ReceiptIndexRecordV1;
    try {
      candidate = bodyRecord({
        receipt_id: input.receipt_id,
        kind: input.kind ?? classifyReceiptKind(input.payload),
        payload: input.payload,
        ...(input.recorded_at !== undefined
          ? { recorded_at: input.recorded_at }
          : {}),
      });
    } catch (error) {
      return {
        ok: false,
        reason: 'invalid_receipt',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const existing = this.records.get(candidate.receipt_id);
    if (existing) {
      if (existing.content_hash === candidate.content_hash)
        return { ok: true, record: existing, created: false };
      return {
        ok: false,
        reason: 'conflicting_receipt_identity',
        detail: candidate.receipt_id,
      };
    }
    const next = [...this.records.values(), candidate];
    try {
      writeDocument(this.filePath, next);
    } catch (error) {
      return {
        ok: false,
        reason: 'index_inconsistent',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const frozen = freezeRecord(candidate);
    this.records.set(candidate.receipt_id, frozen);
    return { ok: true, record: frozen, created: true };
  }

  /** Convenience: classify and record in one step. */
  recordReceipt(input: {
    receipt_id: string;
    payload: unknown;
    recorded_at?: string;
  }): ReceiptIndexRecordResult {
    return this.record(input);
  }

  /**
   * Explicit, non-regenerating lookup. A missing identity resolves to
   * `unavailable`, never to reconstructed text.
   */
  lookup(receipt_id: string): ReceiptLookupResult {
    if (!this.consistent)
      return {
        status: 'unavailable',
        receipt_id,
        reason: 'index_inconsistent',
        detail: this.inconsistentReasons.join(', '),
      };
    const record = this.records.get(receipt_id);
    if (!record)
      return { status: 'unavailable', receipt_id, reason: 'not_recorded' };
    return { status: 'available', receipt: record };
  }

  list(): ReceiptIndexRecordV1[] {
    if (!this.consistent) return [];
    return [...this.records.values()];
  }

  size(): number {
    return this.consistent ? this.records.size : 0;
  }
}

function loadDocument(filePath: string): {
  records: ReceiptIndexRecordV1[];
  reasons: string[];
} {
  if (!fs.existsSync(filePath)) return { records: [], reasons: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return { records: [], reasons: ['index_unreadable'] };
  }
  const parsed = documentSchema.safeParse(raw);
  if (!parsed.success) return { records: [], reasons: ['index_schema_invalid'] };
  const records = parsed.data.entries as ReceiptIndexRecordV1[];
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.receipt_id)) {
      reasons.push('duplicate_receipt_identity');
      break;
    }
    seen.add(record.receipt_id);
    let hash: string;
    try {
      hash = sha256Canonical(record.payload);
    } catch {
      reasons.push('unserializable_payload');
      break;
    }
    if (hash !== record.content_hash) {
      reasons.push('content_hash_mismatch');
      break;
    }
  }
  if (sha256Canonical(records) !== parsed.data.state_hash)
    reasons.push('state_hash_mismatch');
  return { records, reasons };
}

function writeDocument(
  filePath: string,
  records: readonly ReceiptIndexRecordV1[],
): void {
  const document: ReceiptIndexDocumentV1 = {
    schema_version: RECEIPT_INDEX_SCHEMA_VERSION,
    kind: RECEIPT_INDEX_KIND,
    entries: [...records],
    state_hash: sha256Canonical(records),
  };
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${canonicalJson(document)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}
