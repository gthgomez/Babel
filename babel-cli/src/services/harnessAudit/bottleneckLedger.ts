/**
 * bottleneckLedger.ts — durable Bottleneck Ledger (Workstream B,
 * docs/roadmaps/OX_ALPHA_EXPERIMENTAL_PROGRAM.md).
 *
 * An empirical roadmap where harness-trace audit findings accumulate, cluster,
 * and mature into interventions that are shipped, then CONFIRMED or FALSIFIED
 * by controlled replay:
 *
 *   OPEN → INTERVENTION_SHIPPED → CONFIRMED | FALSIFIED
 *
 * Preregistration freeze (anti-HARKing): once an entry leaves OPEN,
 * effect_quantification.direction, effect_quantification.metric_name, and
 * proposed_intervention.preregistered_falsifier are immutable. Amendments
 * touching them are rejected identically at live append and at fold replay.
 *
 * Persistence mirrors src/search/episodeStore.ts conventions: append-only
 * JSONL, one mutation record per line, reload = deterministic fold, corrupt
 * lines / unknown kinds / broken transitions fail closed (never skipped).
 *
 * Replay sign rule — replay_delta := intervention_value − baseline_value on
 * effect_quantification.metric_name:
 *   direction 'improves' ⇒ replay_delta > 0
 *   direction 'worsens'  ⇒ replay_delta < 0
 *   direction 'neutral'  ⇒ replay_delta === 0
 *   direction 'unknown'  ⇒ entry cannot be CONFIRMED (fail closed)
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { HarnessIdentitySchema, type HarnessIdentity } from '../experimentIdentity.js';
import {
  EvidenceRefSchema,
  HypothesisWeightSchema,
  type EvidenceRef,
} from './findings.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const BOTTLENECK_LEDGER_ENTRY_KIND = 'babel_bottleneck_ledger_entry' as const;
export const BOTTLENECK_LEDGER_SCHEMA_VERSION = 1 as const;

export const BOTTLENECK_STATUSES = [
  'OPEN',
  'INTERVENTION_SHIPPED',
  'CONFIRMED',
  'FALSIFIED',
] as const;
export type BottleneckStatus = (typeof BOTTLENECK_STATUSES)[number];

/** Mirrors the inline stage enum literals in findings.ts (not exported there). */
export const AUDIT_STAGES = [
  'context',
  'planning',
  'tool_use',
  'mutation',
  'verification',
  'completion',
  'orchestration',
] as const;
export type AuditStage = (typeof AUDIT_STAGES)[number];

export const EVIDENCE_STRENGTHS = ['weak', 'moderate', 'strong'] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

export const EFFECT_DIRECTIONS = ['improves', 'worsens', 'neutral', 'unknown'] as const;
export type EffectDirection = (typeof EFFECT_DIRECTIONS)[number];

export const LEDGER_FILE_NAME = 'bottleneck-ledger.jsonl' as const;

/** Reused verbatim from the canonical finding contract (findings.ts). */
export type HypothesisWeight = z.infer<typeof HypothesisWeightSchema>;

// ─── Zod schemas (source of truth) ───────────────────────────────────────────

export const EffectQuantificationSchema = z.object({
  metric_name: z.string().min(1),
  baseline_value: z.number().nullable(),
  intervention_value: z.number().nullable(),
  direction: z.enum(EFFECT_DIRECTIONS),
});
export type EffectQuantification = z.infer<typeof EffectQuantificationSchema>;

/**
 * Preregistration discipline: while an entry is OPEN the falsifier MUST be
 * present (checked semantically below), and once INTERVENTION_SHIPPED the
 * description MUST be present. Structurally the strings stay free-form so
 * historical entries remain representable.
 */
export const ProposedInterventionSchema = z.object({
  description: z.string(),
  expected_effect: z.string(),
  preregistered_falsifier: z.string(),
});
export type ProposedIntervention = z.infer<typeof ProposedInterventionSchema>;

export const LedgerResultSchema = z.object({
  verdict: z.enum(['CONFIRMED', 'FALSIFIED']).nullable().default(null),
  replay_delta: z.number().nullable().default(null),
  notes: z.string().default(''),
});
export type LedgerResult = z.infer<typeof LedgerResultSchema>;

export const ObservedAcrossSchema = z.object({
  attempt_count: z.number().int().positive(),
  task_count: z.number().int().nonnegative(),
  model_count: z.number().int().nonnegative(),
});
export type ObservedAcross = z.infer<typeof ObservedAcrossSchema>;

export const BottleneckLedgerEntryIdSchema = z
  .string()
  .regex(/^BB-\d{3,}$/, 'ledger entry id must be a stable slug like BB-001');

export const BottleneckLedgerEntrySchema = z.object({
  schema_version: z.literal(BOTTLENECK_LEDGER_SCHEMA_VERSION),
  kind: z.literal(BOTTLENECK_LEDGER_ENTRY_KIND),
  id: BottleneckLedgerEntryIdSchema,
  status: z.enum(BOTTLENECK_STATUSES),

  claim: z.string().min(20),
  suspected_subsystem: z.string().min(1),
  observed_across: ObservedAcrossSchema,

  harnesses: z.array(HarnessIdentitySchema),
  stages: z.array(z.enum(AUDIT_STAGES)),

  /** Required (filled) once CONFIRMED; may be null earlier. */
  effect_quantification: EffectQuantificationSchema.nullable(),

  evidence_strength: z.enum(EVIDENCE_STRENGTHS),
  /** Required justification for the chosen evidence_strength. */
  evidence_strength_justification: z.string().min(1),
  evidence_refs: z.array(EvidenceRefSchema),

  /** Competing-hypothesis distribution carried over from clustered findings. */
  competing_hypotheses: z.array(HypothesisWeightSchema).min(2),

  proposed_intervention: ProposedInterventionSchema,

  /** Set when the intervention ships (frozen baseline manifest digest). */
  baseline_manifest_sha: z.string().nullable(),
  /** Set by the controlled replay that produced the verdict. */
  rerun_manifest_sha: z.string().nullable(),

  result: LedgerResultSchema,

  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
export type BottleneckLedgerEntry = z.infer<typeof BottleneckLedgerEntrySchema>;

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export const BOTTLENECK_ALLOWED_TRANSITIONS: Readonly<
  Record<BottleneckStatus, readonly BottleneckStatus[]>
> = {
  OPEN: ['INTERVENTION_SHIPPED'],
  INTERVENTION_SHIPPED: ['CONFIRMED', 'FALSIFIED'],
  CONFIRMED: [],
  FALSIFIED: [],
};

export function assertLegalBottleneckTransition(
  from: BottleneckStatus,
  to: BottleneckStatus,
): void {
  if (!BOTTLENECK_ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(
      `illegal bottleneck ledger transition ${from} → ${to} (allowed: OPEN → INTERVENTION_SHIPPED → CONFIRMED|FALSIFIED)`,
    );
  }
}

/**
 * Sign-agreement rule between the preregistered effect direction and the
 * measured controlled-replay delta. `replay_delta` is defined as
 * intervention_value − baseline_value on effect_quantification.metric_name.
 */
export function replayDeltaMatchesDirection(
  direction: EffectDirection,
  replayDelta: number | null,
): boolean {
  if (replayDelta === null) return false;
  switch (direction) {
    case 'improves':
      return replayDelta > 0;
    case 'worsens':
      return replayDelta < 0;
    case 'neutral':
      return replayDelta === 0;
    case 'unknown':
      return false;
  }
}

/**
 * Fail-closed semantic validation beyond zod structure. Returns problem
 * strings; empty array means the entry is semantically consistent.
 */
export function validateBottleneckEntrySemantics(entry: BottleneckLedgerEntry): string[] {
  const problems: string[] = [];
  const active = entry.status === 'OPEN' || entry.status === 'INTERVENTION_SHIPPED';

  if (active && entry.proposed_intervention.preregistered_falsifier.trim().length === 0) {
    problems.push(`${entry.status} requires a non-empty preregistered_falsifier`);
  }

  if (active) {
    if (entry.result.verdict !== null) {
      problems.push(`premature verdict ${entry.result.verdict} while ${entry.status}`);
    }
    if (entry.rerun_manifest_sha !== null) {
      problems.push(`premature rerun_manifest_sha while ${entry.status}`);
    }
    if (entry.result.replay_delta !== null) {
      problems.push(`premature result.replay_delta while ${entry.status}`);
    }
  }

  if (entry.status === 'INTERVENTION_SHIPPED') {
    if (entry.proposed_intervention.description.trim().length === 0) {
      problems.push('INTERVENTION_SHIPPED requires a non-empty proposed_intervention.description');
    }
    if (entry.baseline_manifest_sha === null) {
      problems.push('INTERVENTION_SHIPPED requires baseline_manifest_sha');
    }
  }

  if (entry.status === 'CONFIRMED' || entry.status === 'FALSIFIED') {
    if (entry.rerun_manifest_sha === null) {
      problems.push(`${entry.status} requires rerun_manifest_sha`);
    }
    if (entry.result.replay_delta === null) {
      problems.push(`${entry.status} requires result.replay_delta`);
    }
    if (entry.result.verdict !== entry.status) {
      problems.push(`result.verdict must equal status ${entry.status}`);
    }
  }

  if (entry.status === 'CONFIRMED') {
    const eq = entry.effect_quantification;
    if (eq === null) {
      problems.push('CONFIRMED requires effect_quantification');
    } else {
      if (eq.baseline_value === null || eq.intervention_value === null) {
        problems.push(
          'CONFIRMED requires concrete baseline_value and intervention_value in effect_quantification',
        );
      }
      if (eq.direction === 'unknown') {
        problems.push("CONFIRMED requires a known direction; 'unknown' cannot be confirmed");
      } else if (
        entry.result.replay_delta !== null &&
        !replayDeltaMatchesDirection(eq.direction, entry.result.replay_delta)
      ) {
        problems.push(
          `sign disagreement: direction '${eq.direction}' does not agree with replay_delta ${entry.result.replay_delta}`,
        );
      }
    }
  }

  return problems;
}

// ─── Mutation records (append-only JSONL) ────────────────────────────────────

/** Payload attached to a transition; requirements depend on the target status. */
export interface TransitionResolution {
  /** REQUIRED when transitioning to INTERVENTION_SHIPPED. */
  baseline_manifest_sha?: string;
  /** REQUIRED (with replay_delta) when transitioning to CONFIRMED/FALSIFIED. */
  rerun_manifest_sha?: string;
  replay_delta?: number;
  result_notes?: string;
  /** Optional replacement quantification recorded at verdict time. */
  effect_quantification?: EffectQuantification | null;
}

export interface EntryOpenedRecord {
  kind: 'entry_opened';
  recorded_at: string;
  entry: BottleneckLedgerEntry;
}

export interface EntryTransitionedRecord {
  kind: 'entry_transitioned';
  recorded_at: string;
  id: string;
  from: BottleneckStatus;
  to: BottleneckStatus;
  at: string;
  reason: string;
  resolution?: TransitionResolution;
}

export interface EntryAmendedRecord {
  kind: 'entry_amended';
  recorded_at: string;
  id: string;
  at: string;
  patch: Record<string, unknown>;
}

export type BottleneckLedgerRecord =
  | EntryOpenedRecord
  | EntryTransitionedRecord
  | EntryAmendedRecord;

const LEDGER_RECORD_KINDS: readonly string[] = ['entry_opened', 'entry_transitioned', 'entry_amended'];

/**
 * Fields an entry_amended patch may touch. Everything else fails closed.
 * Status-aware freeze: while OPEN, preregistration fields may still be
 * sharpened; from INTERVENTION_SHIPPED on, the sub-fields listed in
 * PREREGISTRATION_FROZEN_SUBFIELDS are immutable (see applyAmendment).
 */
export const AMENDABLE_PATCH_KEYS: readonly string[] = [
  'claim',
  'suspected_subsystem',
  'observed_across',
  'harnesses',
  'stages',
  'effect_quantification',
  'evidence_strength',
  'evidence_strength_justification',
  'evidence_refs',
  'competing_hypotheses',
  'proposed_intervention',
  'result_notes',
];

const AMENDABLE_FIELD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  claim: z.string().min(20),
  suspected_subsystem: z.string().min(1),
  observed_across: ObservedAcrossSchema,
  harnesses: z.array(HarnessIdentitySchema),
  stages: z.array(z.enum(AUDIT_STAGES)),
  effect_quantification: EffectQuantificationSchema.nullable(),
  evidence_strength: z.enum(EVIDENCE_STRENGTHS),
  evidence_strength_justification: z.string().min(1),
  evidence_refs: z.array(EvidenceRefSchema),
  competing_hypotheses: z.array(HypothesisWeightSchema).min(2),
  proposed_intervention: ProposedInterventionSchema,
  result_notes: z.string(),
};

/**
 * Preregistration freeze: patch key → sub-fields whose values may not change
 * once an entry has left OPEN (INTERVENTION_SHIPPED and later). Enforced in
 * applyAmendment, which both the live append validation and the fold replay
 * share — a hand-crafted log cannot bypass what the live path rejects.
 */
export const PREREGISTRATION_FROZEN_SUBFIELDS: Readonly<
  Record<string, readonly string[]>
> = {
  effect_quantification: ['direction', 'metric_name'],
  proposed_intervention: ['preregistered_falsifier'],
};

export function parseBottleneckRecordLine(
  line: string,
  lineNumber: number,
): BottleneckLedgerRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`corrupt bottleneck ledger record at line ${lineNumber}`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`malformed bottleneck ledger record at line ${lineNumber}`);
  }
  const kind = (parsed as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !LEDGER_RECORD_KINDS.includes(kind)) {
    throw new Error(
      `unknown bottleneck ledger record kind at line ${lineNumber}: ${JSON.stringify(kind ?? null)}`,
    );
  }
  return parsed as BottleneckLedgerRecord;
}

// ─── Fold ────────────────────────────────────────────────────────────────────

interface ParsedRecord {
  record: BottleneckLedgerRecord;
  line: number;
}

function whereOf(parsed: ParsedRecord): string {
  return `line ${parsed.line}`;
}

function zodIssuesMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

function parseEntryPayload(raw: unknown, where: string): BottleneckLedgerEntry {
  const parsed = BottleneckLedgerEntrySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid bottleneck ledger entry at ${where}: ${zodIssuesMessage(parsed.error)}`);
  }
  const problems = validateBottleneckEntrySemantics(parsed.data);
  if (problems.length > 0) {
    throw new Error(
      `semantically invalid bottleneck ledger entry at ${where}: ${problems.join('; ')}`,
    );
  }
  return parsed.data;
}

/**
 * Apply one transition to a cloned entry. Structural requirements are checked
 * here (missing resolution payloads fail closed with the offending position).
 */
function applyTransition(
  current: BottleneckLedgerEntry,
  rec: EntryTransitionedRecord,
  where: string,
): BottleneckLedgerEntry {
  const next: BottleneckLedgerEntry = { ...structuredClone(current), status: rec.to, updated_at: rec.at };
  const res = rec.resolution;

  if (rec.to === 'INTERVENTION_SHIPPED') {
    if (!res || typeof res.baseline_manifest_sha !== 'string' || res.baseline_manifest_sha.length === 0) {
      throw new Error(
        `transition to INTERVENTION_SHIPPED requires resolution.baseline_manifest_sha (${where}, entry ${rec.id})`,
      );
    }
    next.baseline_manifest_sha = res.baseline_manifest_sha;
    return next;
  }

  if (rec.to === 'CONFIRMED' || rec.to === 'FALSIFIED') {
    if (
      !res ||
      typeof res.rerun_manifest_sha !== 'string' ||
      res.rerun_manifest_sha.length === 0 ||
      typeof res.replay_delta !== 'number'
    ) {
      throw new Error(
        `transition to ${rec.to} requires resolution.rerun_manifest_sha and a numeric resolution.replay_delta (${where}, entry ${rec.id})`,
      );
    }
    next.rerun_manifest_sha = res.rerun_manifest_sha;
    next.result = {
      verdict: rec.to,
      replay_delta: res.replay_delta,
      notes: res.result_notes ?? current.result.notes,
    };
    if (res.effect_quantification !== undefined) {
      next.effect_quantification = structuredClone(res.effect_quantification);
    }
    return next;
  }

  throw new Error(`unsupported transition target ${rec.to} (${where}, entry ${rec.id})`);
}

/**
 * Fail-closed preregistration freeze: while status is not OPEN, a patch value
 * must preserve every frozen sub-field exactly as recorded (erasing or
 * introducing one counts as a change). Shared by live append and fold replay
 * so both paths reject identically; error names the key and the status.
 */
function assertPreregistrationFreezeRespected(
  current: BottleneckLedgerEntry,
  key: string,
  value: unknown,
): void {
  if (current.status === 'OPEN') return;
  const frozenFields = PREREGISTRATION_FROZEN_SUBFIELDS[key];
  if (frozenFields === undefined) return;
  const before = (
    key === 'effect_quantification'
      ? current.effect_quantification
      : current.proposed_intervention
  ) as Record<string, unknown> | null;
  const after = value as Record<string, unknown> | null;
  const fieldOf = (obj: Record<string, unknown> | null | undefined, field: string): unknown =>
    obj === null || obj === undefined ? null : obj[field] ?? null;
  for (const field of frozenFields) {
    const previous = fieldOf(before, field);
    const candidate = fieldOf(after, field);
    if (previous !== candidate) {
      throw new Error(
        `amendment patch key '${key}' touches frozen preregistration field '${key}.${field}' while entry ${current.id} is ${current.status} (frozen ${JSON.stringify(previous)} → attempted ${JSON.stringify(candidate)}); preregistration is immutable after INTERVENTION_SHIPPED`,
      );
    }
  }
}

function applyAmendment(
  current: BottleneckLedgerEntry,
  rec: EntryAmendedRecord,
  where: string,
): BottleneckLedgerEntry {
  if (BOTTLENECK_ALLOWED_TRANSITIONS[current.status].length === 0) {
    throw new Error(`entry ${rec.id} is terminal (${current.status}); amendments are closed (${where})`);
  }
  const next: BottleneckLedgerEntry = structuredClone(current);
  for (const key of Object.keys(rec.patch)) {
    if (!AMENDABLE_PATCH_KEYS.includes(key)) {
      throw new Error(
        `amendment patch key '${key}' is not amendable on entry ${rec.id} (${where}); amendable keys: ${AMENDABLE_PATCH_KEYS.join(', ')}`,
      );
    }
    const value = rec.patch[key];
    const schema = AMENDABLE_FIELD_SCHEMAS[key];
    if (!schema) {
      throw new Error(`no validation schema for amendment key '${key}' (${where})`);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `invalid amendment value for '${key}' on entry ${rec.id} (${where}): ${zodIssuesMessage(parsed.error)}`,
      );
    }
    assertPreregistrationFreezeRespected(current, key, parsed.data);
    switch (key) {
      case 'claim':
        next.claim = parsed.data as string;
        break;
      case 'suspected_subsystem':
        next.suspected_subsystem = parsed.data as string;
        break;
      case 'observed_across':
        next.observed_across = parsed.data as ObservedAcross;
        break;
      case 'harnesses':
        next.harnesses = parsed.data as HarnessIdentity[];
        break;
      case 'stages':
        next.stages = parsed.data as AuditStage[];
        break;
      case 'effect_quantification':
        next.effect_quantification = parsed.data as EffectQuantification | null;
        break;
      case 'evidence_strength':
        next.evidence_strength = parsed.data as EvidenceStrength;
        break;
      case 'evidence_strength_justification':
        next.evidence_strength_justification = parsed.data as string;
        break;
      case 'evidence_refs':
        next.evidence_refs = parsed.data as EvidenceRef[];
        break;
      case 'competing_hypotheses':
        next.competing_hypotheses = parsed.data as HypothesisWeight[];
        break;
      case 'proposed_intervention':
        next.proposed_intervention = parsed.data as ProposedIntervention;
        break;
      case 'result_notes':
        next.result = { ...next.result, notes: parsed.data as string };
        break;
      default:
        throw new Error(`unhandled amendment key '${key}' (${where})`);
    }
  }
  next.updated_at = rec.at;
  const reparsed = BottleneckLedgerEntrySchema.safeParse(next);
  if (!reparsed.success) {
    throw new Error(
      `amendment produced invalid entry ${rec.id} (${where}): ${zodIssuesMessage(reparsed.error)}`,
    );
  }
  return reparsed.data;
}

function compareById(a: BottleneckLedgerEntry, b: BottleneckLedgerEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Deterministic fold: same record sequence always yields the same entries.
 * Every intermediate state must be semantically valid — corruption fails at
 * the exact offending line instead of being skipped.
 */
export function foldLedgerRecords(
  records: readonly BottleneckLedgerRecord[],
): BottleneckLedgerEntry[] {
  const parsedRecords: ParsedRecord[] = records.map((record, idx) => ({
    record,
    line: idx + 1,
  }));
  return foldParsedRecords(parsedRecords);
}

function foldParsedRecords(parsedRecords: readonly ParsedRecord[]): BottleneckLedgerEntry[] {
  const byId = new Map<string, BottleneckLedgerEntry>();
  for (const parsed of parsedRecords) {
    const where = whereOf(parsed);
    const rec = parsed.record;
    switch (rec.kind) {
      case 'entry_opened': {
        const entry = parseEntryPayload(rec.entry, where);
        if (entry.status !== 'OPEN') {
          throw new Error(`entries must open as OPEN at ${where}; got ${entry.status} (${entry.id})`);
        }
        if (byId.has(entry.id)) {
          throw new Error(`duplicate entry_opened for ${entry.id} at ${where}`);
        }
        byId.set(entry.id, entry);
        break;
      }
      case 'entry_transitioned': {
        const current = byId.get(rec.id);
        if (!current) {
          throw new Error(`transition references unknown ledger entry ${rec.id} at ${where}`);
        }
        if (current.status !== rec.from) {
          throw new Error(
            `broken transition for ${rec.id} at ${where}: recorded from=${rec.from} but folded status=${current.status}`,
          );
        }
        assertLegalBottleneckTransition(rec.from, rec.to);
        const next = applyTransition(current, rec, where);
        const problems = validateBottleneckEntrySemantics(next);
        if (problems.length > 0) {
          throw new Error(
            `transition left ${rec.id} semantically invalid at ${where}: ${problems.join('; ')}`,
          );
        }
        byId.set(rec.id, next);
        break;
      }
      case 'entry_amended': {
        const current = byId.get(rec.id);
        if (!current) {
          throw new Error(`amendment references unknown ledger entry ${rec.id} at ${where}`);
        }
        const next = applyAmendment(current, rec, where);
        const problems = validateBottleneckEntrySemantics(next);
        if (problems.length > 0) {
          throw new Error(
            `amendment left ${rec.id} semantically invalid at ${where}: ${problems.join('; ')}`,
          );
        }
        byId.set(rec.id, next);
        break;
      }
      default: {
        const _exhaustive: never = rec;
        throw new Error(`unknown bottleneck ledger record kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
  return [...byId.values()].sort(compareById);
}

function readLedgerRecords(filePath: string): ParsedRecord[] {
  const raw = readFileSync(filePath, 'utf-8');
  const out: ParsedRecord[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (text === undefined || text.trim().length === 0) continue;
    out.push({ record: parseBottleneckRecordLine(text, i + 1), line: i + 1 });
  }
  return out;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export interface NewBottleneckEntryInput {
  id?: string;
  claim: string;
  suspected_subsystem: string;
  observed_across: ObservedAcross;
  harnesses: HarnessIdentity[];
  stages: AuditStage[];
  effect_quantification?: EffectQuantification | null;
  evidence_strength: EvidenceStrength;
  evidence_strength_justification: string;
  evidence_refs: EvidenceRef[];
  competing_hypotheses: HypothesisWeight[];
  proposed_intervention: ProposedIntervention;
}

/** Next free stable slug (BB-001 style) given existing ids. */
export function nextBottleneckId(existingIds: readonly string[]): string {
  let max = 0;
  for (const id of existingIds) {
    const match = /^BB-(\d{3,})$/.exec(id);
    const numeric = match?.[1];
    if (numeric !== undefined) {
      max = Math.max(max, Number.parseInt(numeric, 10));
    }
  }
  return `BB-${String(max + 1).padStart(3, '0')}`;
}

/**
 * Append-only JSONL store for BottleneckLedgerEntry state. Persisted history
 * and live state can never diverge: every mutation appends exactly one record
 * that is both written and folded into memory (episodeStore convention).
 * Single-line appends are the crash-safe primitive for JSONL logs; the
 * temp+rename precedent applies to whole-file rewrites, which this store
 * never performs.
 */
export class BottleneckLedgerStore {
  private constructor(
    readonly filePath: string,
    private entriesById: Map<string, BottleneckLedgerEntry>,
  ) {}

  /** Creates a new empty ledger file; refuses to overwrite an existing one. */
  static init(filePath: string): BottleneckLedgerStore {
    if (existsSync(filePath)) {
      throw new Error(`bottleneck ledger store already exists at ${filePath}`);
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, '', 'utf-8');
    return new BottleneckLedgerStore(filePath, new Map());
  }

  static load(filePath: string): BottleneckLedgerStore {
    const entries = foldParsedRecords(readLedgerRecords(filePath));
    return new BottleneckLedgerStore(filePath, new Map(entries.map((e) => [e.id, e])));
  }

  get entries(): BottleneckLedgerEntry[] {
    return [...this.entriesById.values()].sort(compareById).map((e) => structuredClone(e));
  }

  getEntry(id: string): BottleneckLedgerEntry | undefined {
    const entry = this.entriesById.get(id);
    return entry ? structuredClone(entry) : undefined;
  }

  appendOpenEntry(input: NewBottleneckEntryInput): BottleneckLedgerEntry {
    const id = input.id ?? nextBottleneckId([...this.entriesById.keys()]);
    if (!BottleneckLedgerEntryIdSchema.safeParse(id).success) {
      throw new Error(`invalid ledger entry id '${id}': expected slug like BB-001`);
    }
    if (this.entriesById.has(id)) {
      throw new Error(`duplicate ledger entry id '${id}'`);
    }
    const now = new Date().toISOString();
    const draft = {
      schema_version: BOTTLENECK_LEDGER_SCHEMA_VERSION,
      kind: BOTTLENECK_LEDGER_ENTRY_KIND,
      id,
      status: 'OPEN' as const,
      claim: input.claim,
      suspected_subsystem: input.suspected_subsystem,
      observed_across: input.observed_across,
      harnesses: input.harnesses,
      stages: input.stages,
      effect_quantification: input.effect_quantification ?? null,
      evidence_strength: input.evidence_strength,
      evidence_strength_justification: input.evidence_strength_justification,
      evidence_refs: input.evidence_refs,
      competing_hypotheses: input.competing_hypotheses,
      proposed_intervention: input.proposed_intervention,
      baseline_manifest_sha: null,
      rerun_manifest_sha: null,
      result: { verdict: null, replay_delta: null, notes: '' },
      created_at: now,
      updated_at: now,
    };
    const entry = parseEntryPayload(draft, `appendOpenEntry(${id})`);
    this.appendRecord({ kind: 'entry_opened', recorded_at: now, entry });
    this.entriesById.set(id, entry);
    return structuredClone(entry);
  }

  appendTransition(
    id: string,
    to: BottleneckStatus,
    reason: string,
    resolution?: TransitionResolution,
  ): BottleneckLedgerEntry {
    if (reason.trim().length === 0) {
      throw new Error('ledger transition reason is required');
    }
    const current = this.entriesById.get(id);
    if (!current) {
      throw new Error(`unknown ledger entry ${id}`);
    }
    assertLegalBottleneckTransition(current.status, to);
    const now = new Date().toISOString();
    const record: EntryTransitionedRecord = {
      kind: 'entry_transitioned',
      recorded_at: now,
      id,
      from: current.status,
      to,
      at: now,
      reason,
      ...(resolution !== undefined ? { resolution } : {}),
    };
    const next = applyTransition(current, record, `appendTransition(${id})`);
    const problems = validateBottleneckEntrySemantics(next);
    if (problems.length > 0) {
      throw new Error(`invalid transition of ${id} to ${to}: ${problems.join('; ')}`);
    }
    this.appendRecord(record);
    this.entriesById.set(id, next);
    return structuredClone(next);
  }

  appendAmendment(id: string, patch: Record<string, unknown>): BottleneckLedgerEntry {
    const current = this.entriesById.get(id);
    if (!current) {
      throw new Error(`unknown ledger entry ${id}`);
    }
    if (BOTTLENECK_ALLOWED_TRANSITIONS[current.status].length === 0) {
      throw new Error(`entry ${id} is terminal (${current.status}); amendments are closed`);
    }
    const now = new Date().toISOString();
    const record: EntryAmendedRecord = {
      kind: 'entry_amended',
      recorded_at: now,
      id,
      at: now,
      patch: { ...patch },
    };
    const next = applyAmendment(current, record, `appendAmendment(${id})`);
    const problems = validateBottleneckEntrySemantics(next);
    if (problems.length > 0) {
      throw new Error(`invalid amendment of ${id}: ${problems.join('; ')}`);
    }
    this.appendRecord(record);
    this.entriesById.set(id, next);
    return structuredClone(next);
  }

  /** Persists the record and folds the identical object into live state. */
  private appendRecord(record: BottleneckLedgerRecord): void {
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf-8');
  }
}

// ─── Directory-level helpers ─────────────────────────────────────────────────

export function bottleneckLedgerPath(dir: string): string {
  return join(dir, LEDGER_FILE_NAME);
}

/** Creates `<dir>/bottleneck-ledger.jsonl`; refuses to overwrite. */
export function createBottleneckLedgerStore(dir: string): BottleneckLedgerStore {
  return BottleneckLedgerStore.init(bottleneckLedgerPath(dir));
}

/** Reloads the folded ledger entries (sorted by id). Throws on corruption. */
export function loadBottleneckLedger(dir: string): BottleneckLedgerEntry[] {
  return BottleneckLedgerStore.load(bottleneckLedgerPath(dir)).entries;
}
