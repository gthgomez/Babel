/**
 * traceAuditor/traceAuditor.ts — offline harness TRACE AUDITOR (W5 / workstream E).
 *
 * Deterministic, heuristic v1 analyzer over COMPLETED run directories. No LLM.
 * Reads the durable append-only streams real runs produce:
 *   - episode-events.jsonl  (camelCase envelope, hash-chained prevHash)
 *   - session-events.jsonl  (snake_case envelope, event_id per line)
 *   - policy-events.jsonl   ({at_turn, kind, detail?, tool?} — has NO durable
 *     id field, so evidence refs synthesize stable ids `policy:L<lineNumber>`,
 *     which are durable under the append-only store discipline).
 *
 * The auditor is NOT a "find problems with Babel" critic: every finding must
 * distribute evidence weight across >=2 competing hypotheses and may
 * legitimately conclude "probably not Babel" (MODEL/TASK/REPOSITORY dominant
 * allocations are first-class outcomes).
 *
 * Fail-closed discipline mirrors the repo's append-only stores: ANY line that
 * fails structural validation aborts the audit (ok:false) with the offending
 * file, total bad-line count, and first offending line number. No silent skips.
 *
 * Confidence formula (documented): c(n) = clamp(0.35 + 0.08*n, 0.05, 0.95)
 * where n = supporting evidence-ref count (saturates at n >= 8). Monotone in n.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  AUDIT_FINDING_KIND,
  AUDIT_FINDING_SCHEMA_VERSION,
  parseAuditFinding,
  type AuditFinding,
  type EvidenceRef,
  type HypothesisLabel,
} from '../harnessAudit/findings.js';

export const TRACE_AUDIT_REPORT_KIND = 'babel_trace_audit_report' as const;
export const TRACE_AUDIT_REPORT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_MAX_FINDINGS_PER_SIGNATURE = 5;

export const TRACE_AUDIT_SIGNATURES = [
  'VERIFICATION_BLOCKED',
  'UNVERIFIED_COMPLETION',
  'SUCCEEDED_DESPITE_HARNESS',
  'RETRY_STORM',
  'CONTEXT_PRESSURE',
  'TOOL_MALFORMAT',
] as const;
export type TraceAuditSignature = (typeof TRACE_AUDIT_SIGNATURES)[number];

export const TraceAuditReportSchema = z.object({
  kind: z.literal(TRACE_AUDIT_REPORT_KIND),
  schema_version: z.literal(TRACE_AUDIT_REPORT_SCHEMA_VERSION),
  run_dir: z.string().min(1),
  generated_at: z.string().optional(),
  signatures_run: z.array(z.string().min(1)).min(1),
  findings_count: z.number().int().nonnegative(),
  problems: z.array(z.string()),
});
export type TraceAuditReport = z.infer<typeof TraceAuditReportSchema>;

export interface TraceAuditInput {
  runDir: string;
  task_id?: string | null;
  arm?: string | null;
  model?: string | null;
  attempt_id?: string | null;
  campaign_id?: string | null;
  max_findings_per_signature?: number;
  /** Injected ISO clock for deterministic output (tests/replays). */
  now?: string;
}

export type TraceAuditResult =
  | { ok: true; findings: AuditFinding[]; report: TraceAuditReport }
  | { ok: false; reason: string };

// ─── Stream discovery ────────────────────────────────────────────────────────

const STREAM_FILENAMES: ReadonlySet<string> = new Set([
  'episode-events.jsonl',
  'session-events.jsonl',
  'policy-events.jsonl',
]);
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist']);
const MAX_SCAN_DEPTH = 4;

function discoverStreamFiles(runDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (STREAM_FILENAMES.has(entry.name)) found.push(full);
    }
  };
  walk(runDir, 0);
  // Deterministic order regardless of filesystem enumeration order.
  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ─── Loaded event model ──────────────────────────────────────────────────────

interface LoadedEvent {
  ref: EvidenceRef;
  /** Normalized detection label: session kind, episode `type`, or policy kind. */
  kindLabel: string;
  ts: string;
  seq: number;
  filePath: string;
  data: Record<string, unknown>;
}

interface FileParseOutcome {
  events: LoadedEvent[];
  badLineCount: number;
  firstBadLine: number | null;
  notes: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a field from an event's top level or (for episode events) payload. */
function fieldOf(event: LoadedEvent, key: string): unknown {
  if (key in event.data) return event.data[key];
  const payload = event.data['payload'];
  if (isPlainObject(payload) && key in payload) return payload[key];
  return undefined;
}

function strOf(event: LoadedEvent, key: string): string | null {
  const value = fieldOf(event, key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numOf(event: LoadedEvent, key: string): number | null {
  const value = fieldOf(event, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boolOf(event: LoadedEvent, key: string): boolean | null {
  const value = fieldOf(event, key);
  return typeof value === 'boolean' ? value : null;
}

interface RawLine {
  text: string;
  lineNumber: number;
}

function rawLines(raw: string): RawLine[] {
  const out: RawLine[] = [];
  const parts = raw.split(/\r?\n/);
  for (const [i, text] of parts.entries()) {
    if (text.trim().length === 0) continue; // trailing newline / blank padding only
    out.push({ text, lineNumber: i + 1 });
  }
  return out;
}

function requireEnvelope(
  value: unknown,
  checks: Array<{ key: string; test: (v: unknown) => boolean }>,
): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  for (const check of checks) {
    if (!(check.key in value) || !check.test(value[check.key])) return null;
  }
  return value;
}

const isNonEmptyString = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
const isSeq = (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

function parseSessionFile(filePath: string, raw: string): FileParseOutcome {
  const events: LoadedEvent[] = [];
  let badLineCount = 0;
  let firstBadLine: number | null = null;
  const notes: string[] = [];
  for (const line of rawLines(raw)) {
    const value = requireEnvelope(safeJsonParse(line.text), [
      { key: 'schema_version', test: (v) => v === 1 },
      { key: 'event_id', test: isNonEmptyString },
      { key: 'session_id', test: isNonEmptyString },
      { key: 'kind', test: isNonEmptyString },
      { key: 'seq', test: isSeq },
      { key: 'ts', test: isNonEmptyString },
    ]);
    if (value === null) {
      badLineCount += 1;
      if (firstBadLine === null) firstBadLine = line.lineNumber;
      continue;
    }
    events.push({
      ref: { source: 'session_event', id: String(value['event_id']) },
      kindLabel: String(value['kind']),
      ts: String(value['ts']),
      seq: Number(value['seq']),
      filePath,
      data: value,
    });
  }
  return { events, badLineCount, firstBadLine, notes };
}

function parseEpisodeFile(filePath: string, raw: string): FileParseOutcome {
  const events: LoadedEvent[] = [];
  let badLineCount = 0;
  let firstBadLine: number | null = null;
  const notes: string[] = [];
  for (const line of rawLines(raw)) {
    const value = requireEnvelope(safeJsonParse(line.text), [
      { key: 'schemaVersion', test: (v) => v === 1 },
      { key: 'eventId', test: isNonEmptyString },
      { key: 'sessionId', test: isNonEmptyString },
      { key: 'kind', test: isNonEmptyString },
      { key: 'type', test: isNonEmptyString },
      { key: 'seq', test: isSeq },
      { key: 'ts', test: isNonEmptyString },
    ]);
    if (value === null) {
      badLineCount += 1;
      if (firstBadLine === null) firstBadLine = line.lineNumber;
      continue;
    }
    const kindLabel = `${String(value['kind'])}:${String(value['type'])}`;
    events.push({
      ref: { source: 'episode_event', id: String(value['eventId']) },
      kindLabel,
      ts: String(value['ts']),
      seq: Number(value['seq']),
      filePath,
      data: value,
    });
  }
  return { events, badLineCount, firstBadLine, notes };
}

/**
 * Policy streams carry no durable id, so each line's synthesized evidence id
 * is its 1-based line number (`policy:L<n>`), stable under append-only writes.
 */
function parsePolicyFile(filePath: string, raw: string): FileParseOutcome {
  const events: LoadedEvent[] = [];
  let badLineCount = 0;
  let firstBadLine: number | null = null;
  const notes: string[] = [];
  for (const line of rawLines(raw)) {
    const parsed = safeJsonParse(line.text);
    const value = isPlainObject(parsed) ? parsed : null;
    const plausible =
      value !== null &&
      ((typeof value['at_turn'] === 'number' && Number.isFinite(value['at_turn'])) ||
        isNonEmptyString(value['kind']));
    if (value === null || !plausible) {
      badLineCount += 1;
      if (firstBadLine === null) firstBadLine = line.lineNumber;
      continue;
    }
    const kind = isNonEmptyString(value['kind']) ? String(value['kind']) : 'unknown';
    events.push({
      ref: { source: 'policy_event', id: `policy:L${line.lineNumber}` },
      kindLabel: kind,
      ts: '',
      seq: typeof value['at_turn'] === 'number' ? value['at_turn'] : line.lineNumber,
      filePath,
      data: value,
    });
  }
  return { events, badLineCount, firstBadLine, notes };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const SOURCE_RANK: Record<EvidenceRef['source'], number> = {
  episode_event: 0,
  session_event: 1,
  policy_event: 2,
  verifier_receipt: 3,
  cell_evidence: 4,
  transcript: 5,
};

function compareEvents(a: LoadedEvent, b: LoadedEvent): number {
  // Policy events carry no wall-clock ts (only at_turn); the policy stream
  // flushes at end of run, so they deterministically order after all
  // timestamped session/episode events rather than pretending an instant.
  const aTs = a.ts.length > 0 ? a.ts : null;
  const bTs = b.ts.length > 0 ? b.ts : null;
  if (aTs !== null && bTs !== null && aTs !== bTs) return aTs < bTs ? -1 : 1;
  if (aTs === null && bTs !== null) return 1;
  if (bTs === null && aTs !== null) return -1;
  if (SOURCE_RANK[a.ref.source] !== SOURCE_RANK[b.ref.source]) {
    return SOURCE_RANK[a.ref.source] - SOURCE_RANK[b.ref.source];
  }
  if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0;
}

interface LoadStreamsOk {
  ok: true;
  events: LoadedEvent[];
  notes: string[];
}
interface LoadStreamsFail {
  ok: false;
  reason: string;
}

function loadStreams(runDir: string): LoadStreamsOk | LoadStreamsFail {
  if (!existsSync(runDir)) {
    return { ok: false, reason: `run directory does not exist: ${runDir}` };
  }
  if (!statSync(runDir).isDirectory()) {
    return { ok: false, reason: `run path is not a directory: ${runDir}` };
  }
  const files = discoverStreamFiles(runDir);
  if (files.length === 0) {
    return {
      ok: false,
      reason: `no recognizable harness streams found under ${runDir} (looked for episode-events.jsonl, session-events.jsonl, policy-events.jsonl)`,
    };
  }

  const allEvents: LoadedEvent[] = [];
  const notes: string[] = [];
  let totalBad = 0;
  let firstOffender: { file: string; line: number } | null = null;

  for (const filePath of files) {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (error: unknown) {
      return { ok: false, reason: `unreadable stream file ${filePath}: ${String(error)}` };
    }
    const base = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
    const outcome =
      base === 'episode-events.jsonl'
        ? parseEpisodeFile(filePath, raw)
        : base === 'policy-events.jsonl'
          ? parsePolicyFile(filePath, raw)
          : parseSessionFile(filePath, raw);
    if (outcome.notes.length > 0) notes.push(...outcome.notes.map((n) => `${filePath}: ${n}`));
    if (outcome.badLineCount > 0) {
      totalBad += outcome.badLineCount;
      if (
        firstOffender === null ||
        filePath < firstOffender.file ||
        (filePath === firstOffender.file && (outcome.firstBadLine ?? 0) < firstOffender.line)
      ) {
        firstOffender = { file: filePath, line: outcome.firstBadLine ?? 0 };
      }
      continue;
    }
    if (outcome.events.length === 0) notes.push(`${filePath}: stream file is empty`);
    allEvents.push(...outcome.events);
  }

  if (totalBad > 0 && firstOffender !== null) {
    return {
      ok: false,
      reason:
        `malformed harness streams: ${totalBad} unparseable line(s); ` +
        `first offender ${firstOffender.file} line ${firstOffender.line} — fail-closed, refusing partial analysis`,
    };
  }

  allEvents.sort(compareEvents);
  return { ok: true, events: allEvents, notes };
}

// ─── Detection primitives ────────────────────────────────────────────────────

const VERIFICATION_RE =
  /\b(test|tests|vitest|jest|pytest|mocha|tsc|lint|eslint|biome|ruff|type-?check|build|compile|verify|cargo\s+test|go\s+test|npm\s+(run\s+)?test)\b/i;

const DENY_POLICY_KINDS: ReadonlySet<string> = new Set([
  'policy_deny',
  'phase_gate_block',
  'plan_gate_block',
  'readiness_block',
  'budget_kill',
  'zero_write_hard_stop',
]);

const MUTATION_POLICY_KINDS: ReadonlySet<string> = new Set([
  'write_apply',
  'write_receipt',
  'git_patch',
]);

const MALFORMAT_POLICY_KINDS: ReadonlySet<string> = new Set([
  'tool_parse_reject',
  'arg_validation_fail',
]);

const PASSING_TURN_OUTCOMES: ReadonlySet<string> = new Set([
  'VERIFIED_COMPLETE',
  'UNVERIFIED_PATCH',
  'NO_CHANGE_REQUIRED',
]);

const READ_TOOL_RE = /(read|view|cat|grep|search|list|glob|open|show|inspect)/i;

function kindOf(event: LoadedEvent): string {
  return event.kindLabel.includes(':') ? event.kindLabel.split(':')[1] ?? '' : event.kindLabel;
}

function isSessionKind(event: LoadedEvent, kinds: ReadonlySet<string>): boolean {
  return event.ref.source === 'session_event' && kinds.has(kindOf(event));
}

function isPolicyKind(event: LoadedEvent, kinds: ReadonlySet<string>): boolean {
  return event.ref.source === 'policy_event' && kinds.has(kindOf(event));
}

function isMutation(event: LoadedEvent): boolean {
  if (event.ref.source === 'session_event') return kindOf(event) === 'mutation_batch';
  if (event.ref.source === 'episode_event') return kindOf(event) === 'mutation_batch';
  return isPolicyKind(event, MUTATION_POLICY_KINDS);
}

function denyText(event: LoadedEvent): string | null {
  const candidates = ['detail', 'action', 'reason', 'tool', 'command_preview'];
  for (const key of candidates) {
    const value = strOf(event, key);
    if (value !== null) return value;
  }
  return null;
}

function isDenial(event: LoadedEvent): boolean {
  if (event.ref.source === 'policy_event') return isPolicyKind(event, DENY_POLICY_KINDS);
  if (event.ref.source !== 'session_event') return false;
  if (kindOf(event) !== 'policy_intervened') return false;
  const text = denyText(event) ?? '';
  return /denied|blocked|rejected|disallowed/i.test(text);
}

function verificationTarget(event: LoadedEvent): string | null {
  const candidates = [strOf(event, 'command_preview'), strOf(event, 'detail'), strOf(event, 'tool'), strOf(event, 'action')];
  for (const candidate of candidates) {
    if (candidate !== null && VERIFICATION_RE.test(candidate)) return candidate.slice(0, 120);
  }
  return null;
}

/** Passing verifier receipt: exit 0, or bound receipt with exit 0 and not stale. */
function isPassingVerifier(event: LoadedEvent): boolean {
  if (event.ref.source === 'policy_event') return false;
  if (kindOf(event) !== 'verifier_attempt') return false;
  const exitCode = numOf(event, 'exit_code');
  if (exitCode === 0) return true;
  const receiptRaw = fieldOf(event, 'receipt');
  if (isPlainObject(receiptRaw)) {
    const receiptExit = receiptRaw['exitCode'];
    const stale = receiptRaw['stale'];
    if (receiptExit === 0 && stale !== true) return true;
  }
  return false;
}

function isFailingVerifier(event: LoadedEvent): boolean {
  if (event.ref.source === 'policy_event') return false;
  if (kindOf(event) !== 'verifier_attempt') return false;
  const exitCode = numOf(event, 'exit_code');
  if (exitCode !== null && exitCode !== 0) return true;
  const receiptRaw = fieldOf(event, 'receipt');
  if (isPlainObject(receiptRaw)) {
    const receiptExit = receiptRaw['exitCode'];
    const stale = receiptRaw['stale'];
    return typeof receiptExit === 'number' && (receiptExit !== 0 || stale === true);
  }
  return false;
}

function isCompaction(event: LoadedEvent): boolean {
  return kindOf(event).startsWith('compaction_');
}

function isReadTool(event: LoadedEvent): boolean {
  if (event.ref.source === 'policy_event') return false;
  if (!/^tool_(proposed|started|completed)$/.test(kindOf(event))) return false;
  const toolName = strOf(event, 'tool_name');
  return toolName !== null && READ_TOOL_RE.test(toolName);
}

function readTarget(event: LoadedEvent): string | null {
  return strOf(event, 'target_summary');
}

function finalOutcome(events: readonly LoadedEvent[]): { passing: boolean; label: string } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.ref.source === 'session_event' && kindOf(event) === 'turn_ended') {
      const outcome = strOf(event, 'outcome');
      if (outcome !== null) {
        return { passing: PASSING_TURN_OUTCOMES.has(outcome), label: outcome };
      }
    }
    if (event.ref.source === 'session_event' && kindOf(event) === 'completion_decision') {
      const outcome = strOf(event, 'final_outcome');
      if (outcome !== null) {
        return {
          passing: /pass|succes|complet/i.test(outcome),
          label: outcome,
        };
      }
    }
  }
  return null;
}

function successRequestedDecision(event: LoadedEvent): boolean {
  if (event.ref.source !== 'session_event' || kindOf(event) !== 'completion_decision') return false;
  if (boolOf(event, 'allowed') !== true) return false;
  const requested = strOf(event, 'requested_outcome') ?? '';
  const finalOutcomeText = strOf(event, 'final_outcome') ?? '';
  return /complet|succes|pass/i.test(requested) || /pass|succes|complet/i.test(finalOutcomeText);
}

// ─── Finding construction ────────────────────────────────────────────────────

interface FalsificationSpec {
  description: string;
  preregistered_prediction: string;
  success_metric: string;
}

export type WeightAllocation = ReadonlyArray<readonly [HypothesisLabel, number]>;

interface FindingSeed {
  signature: TraceAuditSignature;
  stage: 'context' | 'planning' | 'tool_use' | 'mutation' | 'verification' | 'completion' | 'orchestration';
  claim: string;
  expected_capability: string;
  observed_behavior: string;
  impact: string;
  counterfactual: string;
  falsification: FalsificationSpec;
  refs: EvidenceRef[];
  weights: WeightAllocation;
  nearMiss?: boolean;
  succeededDespiteHarness?: boolean;
}

interface RunIdentityContext {
  taskId: string;
  arm: string;
  model: string | null;
  attemptId: string | null;
  campaignId: string | null;
  runDir: string;
  producedAt: string;
}

class TraceAuditInternalError extends Error {}

function dedupeRefs(refs: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.source}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: ref.source, id: ref.id });
  }
  return out;
}

function confidenceForEvidenceCount(count: number): number {
  const n = Math.min(Math.max(count, 1), 8);
  const raw = 0.35 + 0.08 * n;
  return Math.round(Math.min(Math.max(raw, 0.05), 0.95) * 100) / 100;
}

function buildFinding(seed: FindingSeed, ctx: RunIdentityContext, seq: number): AuditFinding {
  const refs = dedupeRefs(seed.refs);
  if (refs.length === 0) {
    throw new TraceAuditInternalError(`${seed.signature}: finding constructed without evidence refs`);
  }
  const candidate = {
    schema_version: AUDIT_FINDING_SCHEMA_VERSION,
    kind: AUDIT_FINDING_KIND,
    finding_id: `TA-${seed.signature}-${String(seq).padStart(2, '0')}`,
    produced_at: ctx.producedAt,
    task_id: ctx.taskId,
    arm: ctx.arm,
    model: ctx.model,
    attempt_id: ctx.attemptId,
    campaign_id: ctx.campaignId,
    episode_run_dir: ctx.runDir,
    stage: seed.stage,
    claim: seed.claim,
    expected_capability: seed.expected_capability,
    observed_behavior: seed.observed_behavior,
    impact: seed.impact,
    evidence_refs: refs,
    hypotheses: seed.weights.map(([label, weight]) => ({
      label,
      weight,
      rationale: rationaleFor(label, seed.signature, refs),
    })),
    confidence: confidenceForEvidenceCount(refs.length),
    counterfactual: seed.counterfactual,
    falsification_experiment: seed.falsification,
    near_miss: seed.nearMiss ?? false,
    succeeded_despite_harness: seed.succeededDespiteHarness ?? false,
    worker_friction_agreement: 'no_worker_report' as const,
  };
  const validated = parseAuditFinding(candidate);
  if (!validated.ok) {
    throw new TraceAuditInternalError(
      `${candidate.finding_id}: failed own contract validation: ${validated.errors.join('; ')}`,
    );
  }
  return validated.finding;
}

function cite(refs: readonly EvidenceRef[], limit = 4): string {
  return refs.slice(0, limit).map((r) => r.id).join(', ');
}

const RATIONALES: Record<TraceAuditSignature, (label: HypothesisLabel, refs: readonly EvidenceRef[]) => string> = {
  VERIFICATION_BLOCKED: (label, refs) => {
    const ids = cite(refs);
    if (label === 'POLICY') return `Denial events (${ids}) directly blocked the verification commands after edits were applied.`;
    if (label === 'MODEL') return `Model chose command forms (${ids}) that policy did not pre-authorize instead of falling back to allowed equivalents.`;
    return `Task may require commands outside the authorized set, making denials expected friction (${ids}).`;
  },
  UNVERIFIED_COMPLETION: (label, refs) => {
    const ids = cite(refs);
    if (label === 'MODEL') return `Model declared completion (${ids}) without producing any passing verifier receipt.`;
    if (label === 'TASK') return `Task may lack an executable acceptance command, so no receipt could bind (${ids}).`;
    return `Completion gate admitted the request without demanding a fresh receipt (${ids}) — orchestration gap.`;
  },
  SUCCEEDED_DESPITE_HARNESS: (label, refs) => {
    const ids = cite(refs);
    if (label === 'MODEL') return `Model worked around harness friction and still reached a passing outcome (${ids}).`;
    if (label === 'POLICY') return `Interventions fired but were non-decisive for the final result (${ids}).`;
    return `Friction targeted non-critical work, so the task completed regardless (${ids}).`;
  },
  RETRY_STORM: (label, refs) => {
    const ids = cite(refs);
    if (label === 'MODEL') return `Retry causes dominated by model-side signals such as stream_idle/failed settlements (${ids}), pointing away from Babel.`;
    if (label === 'ENVIRONMENT') return `Transport/timeout/rate-limit reasons suggest provider-side instability rather than harness defects (${ids}).`;
    return `Backoff scheduling amplified latency even if root cause was external (${ids}).`;
  },
  CONTEXT_PRESSURE: (label, refs) => {
    const ids = cite(refs);
    if (label === 'HARNESS_CONTEXT') return `Compaction dropped working-set context, forcing repeated re-reads (${ids}).`;
    if (label === 'MODEL') return `Model may re-read habitually rather than using retained context (${ids}).`;
    return `Large working set may exceed any practical capsule size (${ids}).`;
  },
  TOOL_MALFORMAT: (label, refs) => {
    const ids = cite(refs);
    if (label === 'HARNESS_TOOL') return `Repeated schema/parse rejections (${ids}) indicate validation feedback is insufficient.`;
    if (label === 'MODEL') return `Model repeatedly emitted malformed arguments despite rejection feedback (${ids}).`;
    return `Ambiguous tool contracts may make some malformed calls unavoidable (${ids}).`;
  },
};

function rationaleFor(label: HypothesisLabel, signature: TraceAuditSignature, refs: readonly EvidenceRef[]): string {
  return RATIONALES[signature](label, refs);
}

// ─── Signature detectors ─────────────────────────────────────────────────────

function detectVerificationBlocked(events: readonly LoadedEvent[]): FindingSeed[] {
  const firstMutationIdx = events.findIndex(isMutation);
  if (firstMutationIdx < 0) return [];
  // Policy streams flush at end of run, so "after the denial" is not directly
  // observable; the honest post-condition is global: if ANY passing verifier
  // receipt exists after the first mutation, verification was not ultimately
  // blocked and this signature must not fire.
  const hasPassingVerifierAfterMutation = events
    .slice(firstMutationIdx + 1)
    .some((e) => isPassingVerifier(e));
  if (hasPassingVerifierAfterMutation) return [];
  const qualifying = new Map<string, { target: string; denials: LoadedEvent[]; earliest: number }>();
  for (let i = firstMutationIdx + 1; i < events.length; i += 1) {
    const event = events[i]!;
    if (!isDenial(event)) continue;
    const target = verificationTarget(event);
    if (target === null) continue;
    const key = target.toLowerCase().replace(/\s+/g, ' ').trim();
    const group = qualifying.get(key);
    if (group !== undefined) {
      group.denials.push(event);
    } else {
      qualifying.set(key, { target, denials: [event], earliest: i });
    }
  }
  const groups = [...qualifying.values()].sort(
    (a, b) => a.earliest - b.earliest || (a.target < b.target ? -1 : 1),
  );
  const mutationRef = events[firstMutationIdx]!.ref;
  const seeds: FindingSeed[] = [];
  for (const group of groups) {
    const denialRefs = group.denials.map((d) => d.ref);
    seeds.push({
      signature: 'VERIFICATION_BLOCKED',
      stage: 'verification',
      claim:
        `Verification execution '${group.target}' was denied by policy ${group.denials.length} time(s) ` +
        `after mutations (e.g. ${cite(denialRefs)}) and never reached a passing verifier_attempt receipt.`,
      expected_capability:
        'After applying edits, the agent should be able to execute project verification commands without policy interference.',
      observed_behavior:
        `Policy denied '${group.target}' ${group.denials.length} time(s) post-mutation ` +
        `(refs: ${cite(denialRefs)}); no passing verifier_attempt receipt appears afterwards.`,
      impact: 'Mutations remain unverified at end of run; regressions can ship silently.',
      counterfactual:
        `Allow exact command '${group.target}' via a narrow policy rule so post-edit verification runs; ` +
        `a re-audit should then show verifier_attempt receipts bound to the final revision.`,
      falsification: {
        description:
          `Replay the same transcript with a narrow allow-rule for '${group.target}' and no other profile change.`,
        preregistered_prediction:
          'With the allow-rule active, the denied command executes and produces at least one passing verifier_attempt receipt.',
        success_metric: 'count(verifier_attempt with exit_code==0 after last mutation) >= 1 in replay',
      },
      refs: [...denialRefs, mutationRef],
      weights: [['POLICY', 0.6], ['MODEL', 0.25], ['TASK', 0.15]] as WeightAllocation,
    });
  }
  return seeds;
}

function detectUnverifiedCompletion(events: readonly LoadedEvent[]): FindingSeed[] {
  const decisions = events.filter(successRequestedDecision);
  if (decisions.length === 0) return [];
  const decision = decisions[decisions.length - 1]!;
  if (events.some((e) => isPassingVerifier(e))) return [];
  const failing = events.filter((e) => isFailingVerifier(e));
  const nearMiss =
    failing.some((e) => numOf(e, 'exit_code') === 1) ||
    failing.some((e) => {
      const receiptRaw = fieldOf(e, 'receipt');
      return isPlainObject(receiptRaw) && receiptRaw['stale'] === true && receiptRaw['exitCode'] === 0;
    });
  const lastCommand = failing.length > 0 ? strOf(failing[failing.length - 1]!, 'command_preview') ?? 'the last failing verifier' : 'a project verification command';
  const failingRefs = failing.slice(-4).map((e) => e.ref);
  return [{
    signature: 'UNVERIFIED_COMPLETION',
    stage: 'completion',
    claim:
      `Completion was requested and allowed (requested_outcome='${strOf(decision, 'requested_outcome') ?? 'completed'}', ` +
      `ref ${decision.ref.id}) but no passing verifier_attempt receipt is bound anywhere in the run` +
      (failingRefs.length > 0 ? `; failing attempts exist (${cite(failingRefs)}).` : '.'),
    expected_capability: 'Completion should require a fresh, non-stale passing verifier receipt bound to the final revision.',
    observed_behavior:
      `completion_decision ${decision.ref.id} allowed=true with no passing receipt` +
      (failingRefs.length > 0 ? `; nearest evidence is failure/stale receipts (${cite(failingRefs)})` : ''),
    impact: 'The patch ships without executable proof it works; silent regressions are undetected.',
    counterfactual:
      `Rerun '${lastCommand}' to exit_code==0 at the final revision before completion` +
      (nearMiss
        ? '; surface a stale-receipt warning at the turn where the previously-passing receipt was invalidated.'
        : ' or block completion until one binds.'),
    falsification: {
      description: 'Replay with completion gated on a bound non-stale receipt; hold model and task constant.',
      preregistered_prediction: 'The gate blocks completion until a verifier_attempt exits 0, changing final_outcome from UNVERIFIED_PATCH to VERIFIED_COMPLETE.',
      success_metric: 'final turn_ended outcome == VERIFIED_COMPLETE in replay',
    },
    refs: [decision.ref, ...failingRefs],
    weights: [['MODEL', 0.5], ['TASK', 0.3], ['HARNESS_ORCHESTRATION', 0.2]] as WeightAllocation,
    nearMiss,
  }];
}

function detectSucceededDespiteHarness(events: readonly LoadedEvent[]): FindingSeed[] {
  const friction = events.filter((e) => isDenial(e));
  const blockedAttempts = events.filter(
    (e) => e.ref.source === 'session_event' && kindOf(e) === 'tool_cancelled',
  );
  if (friction.length === 0 && blockedAttempts.length === 0) return [];
  const outcome = finalOutcome(events);
  if (outcome === null || !outcome.passing) return [];
  const frictionRefs = [...friction, ...blockedAttempts].map((e) => e.ref);
  const firstTarget = friction.length > 0 ? denyText(friction[0]!) ?? friction[0]!.ref.id : blockedAttempts[0]?.ref.id ?? '';
  return [{
    signature: 'SUCCEEDED_DESPITE_HARNESS',
    stage: 'completion',
    claim:
      `Run ended with passing outcome '${outcome.label}' despite ${friction.length} policy denial(s) and ` +
      `${blockedAttempts.length} blocked/cancelled attempt(s) (${cite(frictionRefs)}) — harness interference occurred but did not decide the result.`,
    expected_capability: 'Harness interventions should be decisive only when necessary, and their effect on outcomes should be attributable.',
    observed_behavior:
      `Outcome '${outcome.label}' recorded while denial/blocked evidence (${cite(frictionRefs)}) exists earlier in the timeline.`,
    impact: 'Success is credited despite friction; without attribution this masks intermittent harness drag.',
    counterfactual:
      `Record whether friction was compensated (e.g., narrow-rule for denied target '${firstTarget}') so replay can attribute the pass without interference.`,
    falsification: {
      description: "Replay with the observed friction removed (allow-rule for the denied target'; no other change).",
      preregistered_prediction: 'The run still passes with fewer interventions, confirming friction was non-decisive.',
      success_metric: 'replay passes AND count(denials) decreases vs original run',
    },
    refs: frictionRefs,
    weights: [['MODEL', 0.4], ['POLICY', 0.35], ['TASK', 0.25]] as WeightAllocation,
    succeededDespiteHarness: true,
  }];
}

function detectRetryStorm(events: readonly LoadedEvent[]): FindingSeed[] {
  const scheduled = events.filter((e) =>
    e.ref.source === 'session_event' &&
    (kindOf(e) === 'provider_retry_scheduled' ||
      kindOf(e) === 'provider_retry_settled'),
  );
  const retries = scheduled.filter((e) => kindOf(e) === 'provider_retry_scheduled');
  if (retries.length < 3) return [];
  const settles = scheduled.filter((e) => kindOf(e) === 'provider_retry_settled');
  const persistent =
    settles.some((e) => {
      const outcome = strOf(e, 'outcome');
      return outcome === 'failed' || outcome === 'cancelled';
    }) || settles.length < retries.length;
  const retryRefs = retries.slice(0, 10).map((e) => e.ref);
  const reasons = new Map<string, number>();
  for (const retry of retries) {
    const reason = strOf(retry, 'reason') ?? 'unknown';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const reasonSummary = [...reasons.entries()].map(([r, n]) => `${r}=${n}`).join(' ');
  const weights: WeightAllocation = persistent
    ? [['MODEL', 0.5], ['ENVIRONMENT', 0.3], ['HARNESS_ORCHESTRATION', 0.2]]
    : [['ENVIRONMENT', 0.5], ['HARNESS_ORCHESTRATION', 0.25], ['MODEL', 0.25]];
  return [{
    signature: 'RETRY_STORM',
    stage: 'orchestration',
    claim:
      `Provider transport required ${retries.length} retries in one run (${reasonSummary}); ` +
      `settlements: ${settles.length}. Evidence: ${cite(retryRefs)}.`,
    expected_capability: 'Provider calls should complete within a small bounded retry envelope under stable conditions.',
    observed_behavior: `${retries.length} provider_retry_scheduled events (${reasonSummary}) with ${settles.length} settlements.`,
    impact: 'Wall-clock budget is consumed by retries, crowding out productive turns and risking budget exhaustion.',
    counterfactual: persistent
      ? `Cap consecutive stream_idle retries and fail over after N timeouts (signals from ${cite(retryRefs, 3)}); replay should show <=2 scheduled retries.`
      : `Pre-warm or raise initial backoff for this provider; replay should show <=2 scheduled retries.`,
    falsification: {
      description: 'Replay the same transcript against a stabilized provider endpoint with identical inputs.',
      preregistered_prediction: persistent
        ? 'If MODEL-dominant holds, retries persist even on a stable endpoint (same stream_idle pattern).'
        : 'If ENVIRONMENT-dominant holds, retries disappear on a stable endpoint.',
      success_metric: 'count(provider_retry_scheduled) <= 2 in replay (environment) or unchanged (model)',
    },
    refs: retryRefs,
    weights,
  }];
}

function detectContextPressure(events: readonly LoadedEvent[]): FindingSeed[] {
  const compactions = events.filter(isCompaction);
  if (compactions.length === 0) return [];
  const firstCompactionIdx = events.findIndex(isCompaction);
  const compactionRef = compactions[0]!.ref;
  const opId = strOf(compactions[0]!, 'operation_id') ?? compactionRef.id;
  const counts = new Map<string, { count: number; refs: EvidenceRef[]; firstIdx: number }>();
  for (let i = firstCompactionIdx + 1; i < events.length; i += 1) {
    const event = events[i]!;
    if (!isReadTool(event)) continue;
    const target = readTarget(event);
    if (target === null) continue;
    const entry = counts.get(target);
    if (entry !== undefined) {
      entry.count += 1;
      entry.refs.push(event.ref);
    } else {
      counts.set(target, { count: 1, refs: [event.ref], firstIdx: i });
    }
  }
  const hot = [...counts.entries()]
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || a[1].firstIdx - b[1].firstIdx || (a[0] < b[0] ? -1 : 1));
  return hot.map(([target, info]) => ({
    signature: 'CONTEXT_PRESSURE' as const,
    stage: 'context' as const,
    claim:
      `After compaction operation '${opId}' (${compactionRef.id}), the agent re-read target '${target}' ` +
      `${info.count} times (${cite(info.refs)}) — post-compaction working-set loss.`,
    expected_capability: 'Post-compaction context should preserve enough working-set state to avoid immediate duplicate reads.',
    observed_behavior: `${info.count} identical post-compaction reads of '${target}' (refs: ${cite(info.refs)}).`,
    impact: 'Duplicate reads waste turns and tokens; lost context can also cause wrong-file edits.',
    counterfactual:
      `Preserve '${target}' contents or an explicit freshness pointer across compaction op '${opId}' so later turns reuse retained context instead of re-reading ${info.count}x.`,
    falsification: {
      description: `Replay with compaction disabled (compaction_mode=off); hold model and task constant.`,
      preregistered_prediction: 'If HARNESS_CONTEXT-dominant holds, duplicate reads drop to <=1 when compaction is off.',
      success_metric: 'count(post-mutation reads of same target) <= 1 in replay',
    },
    refs: [compactionRef, ...info.refs],
    weights: [['HARNESS_CONTEXT', 0.55], ['MODEL', 0.3], ['TASK', 0.15]] as WeightAllocation,
  }));
}

function detectToolMalformat(events: readonly LoadedEvent[]): FindingSeed[] {
  const malformats = events.filter((e) => isPolicyKind(e, MALFORMAT_POLICY_KINDS));
  if (malformats.length < 2) return [];
  const toolsTouched = new Map<string, number>();
  for (const event of malformats) {
    const tool = strOf(event, 'tool') ?? 'unspecified';
    toolsTouched.set(tool, (toolsTouched.get(tool) ?? 0) + 1);
  }
  let topTool = 'unspecified';
  let topCount = 0;
  for (const [tool, n] of toolsTouched) {
    if (n > topCount) {
      topTool = tool;
      topCount = n;
    }
  }
  const refs = malformats.slice(0, 10).map((e) => e.ref);
  return [{
    signature: 'TOOL_MALFORMAT',
    stage: 'tool_use',
    claim:
      `Tool arguments failed schema/parse validation ${malformats.length} times ` +
      `(top tool '${topTool}' x${topCount}; refs ${cite(refs)}) — the model kept emitting malformed calls.`,
    expected_capability: 'Well-formed tool arguments should be emitted after the first explicit validation rejection.',
    observed_behavior: `${malformats.length} tool_parse_reject/arg_validation_fail events (refs: ${cite(refs)}).`,
    impact: 'Turns are wasted on rejected calls; complex tasks stall at the tool boundary.',
    counterfactual:
      `Include a corrective example of the expected argument shape for '${topTool}' in the rejection feedback (as at ${cite(refs, 2)}); replay should show malformat count <= 1.`,
    falsification: {
      description: 'Replay with enriched arg-validation feedback carrying a minimal valid example; hold model and task constant.',
      preregistered_prediction: 'If HARNESS_TOOL-dominant holds, malformat count drops materially with better feedback.',
      success_metric: 'count(tool_parse_reject|arg_validation_fail) <= 1 in replay',
    },
    refs,
    weights: [['HARNESS_TOOL', 0.5], ['MODEL', 0.35], ['TASK', 0.15]] as WeightAllocation,
  }];
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const DETECTORS: ReadonlyArray<{
  signature: TraceAuditSignature;
  run: (events: readonly LoadedEvent[]) => FindingSeed[];
}> = [
  { signature: 'VERIFICATION_BLOCKED', run: detectVerificationBlocked },
  { signature: 'UNVERIFIED_COMPLETION', run: detectUnverifiedCompletion },
  { signature: 'SUCCEEDED_DESPITE_HARNESS', run: detectSucceededDespiteHarness },
  { signature: 'RETRY_STORM', run: detectRetryStorm },
  { signature: 'CONTEXT_PRESSURE', run: detectContextPressure },
  { signature: 'TOOL_MALFORMAT', run: detectToolMalformat },
];

export function runTraceAudit(input: TraceAuditInput): TraceAuditResult {
  const loaded = loadStreams(input.runDir);
  if (!loaded.ok) return { ok: false, reason: loaded.reason };

  const cap = Math.max(1, input.max_findings_per_signature ?? DEFAULT_MAX_FINDINGS_PER_SIGNATURE);
  const producedAt = input.now ?? new Date().toISOString();
  const ctx: RunIdentityContext = {
    taskId: input.task_id ?? 'unknown_task',
    arm: input.arm ?? 'unknown_arm',
    model: input.model ?? null,
    attemptId: input.attempt_id ?? null,
    campaignId: input.campaign_id ?? null,
    runDir: input.runDir,
    producedAt,
  };

  const findings: AuditFinding[] = [];
  try {
    for (const detector of DETECTORS) {
      const seeds = detector.run(loaded.events);
      seeds.sort((a, b) => {
        if (b.refs.length !== a.refs.length) return b.refs.length - a.refs.length;
        const aFirst = dedupeRefs(a.refs)[0]?.id ?? '';
        const bFirst = dedupeRefs(b.refs)[0]?.id ?? '';
        return aFirst < bFirst ? -1 : aFirst > bFirst ? 1 : 0;
      });
      const capped = seeds.slice(0, cap);
      capped.forEach((seed, index) => {
        findings.push(buildFinding(seed, ctx, index + 1));
      });
    }
  } catch (error: unknown) {
    return {
      ok: false,
      reason: error instanceof TraceAuditInternalError
        ? error.message
        : `internal auditor error: ${String(error)}`,
    };
  }

  const report: TraceAuditReport = TraceAuditReportSchema.parse({
    kind: TRACE_AUDIT_REPORT_KIND,
    schema_version: TRACE_AUDIT_REPORT_SCHEMA_VERSION,
    run_dir: input.runDir,
    generated_at: producedAt,
    signatures_run: [...TRACE_AUDIT_SIGNATURES],
    findings_count: findings.length,
    problems: loaded.notes,
  });

  return { ok: true, findings, report };
}
