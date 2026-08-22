/**
 * EpisodeStore V0 — append-only JSONL persistence for SearchEpisode state
 * (SEARCH_EPISODES_V0 B1).
 *
 * Durable structured truth: every mutation appends exactly one record that is
 * both persisted and folded into in-memory state, so persisted history and
 * live state can never diverge. Unknown record types fail closed on load.
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WorkspaceRevisionIdentity } from '../executor/contracts.js';
import {
  CANDIDATE_STATUSES,
  LINEAGE_EDGE_KINDS,
  LINEAGE_ROOT_REF,
  newLineageEdgeId,
  newCandidateId,
  SEARCH_EPISODE_VERSION,
  validateCurrentBestConsistency,
  validateScoreReceipt,
  validateSearchEpisode,
  type Candidate,
  type CandidateStatus,
  type HypothesisRecord,
  type LineageEdge,
  type LineageEdgeKind,
  type ScoreReceipt,
  type SearchEpisode,
  type SupervisorEvent,
} from './types.js';

export interface NewCandidateInput {
  parent_candidate_id?: string;
  workspace_revision: WorkspaceRevisionIdentity | { compositeTreeHash: string };
  mutation_refs: string[];
  hypothesis_id?: string;
}

export type SearchRecordType =
  | 'episode_header'
  | 'candidate'
  | 'lineage_edge'
  | 'hypothesis'
  | 'score_receipt'
  | 'status_change'
  | 'supervisor_event';

const SEARCH_RECORD_TYPES: readonly SearchRecordType[] = [
  'episode_header',
  'candidate',
  'lineage_edge',
  'hypothesis',
  'score_receipt',
  'status_change',
  'supervisor_event',
];

const HYPOTHESIS_DISPOSITIONS: readonly HypothesisRecord['disposition'][] = [
  'open',
  'supported',
  'disproven',
  'abandoned',
];

export interface SearchRecord {
  type: SearchRecordType;
  recorded_at: string;
  payload: unknown;
}

interface StatusChangePayload {
  candidate_id: string;
  status: CandidateStatus;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(
  payload: Record<string, unknown>,
  field: string,
  what: string,
): void {
  const v = payload[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${what} field ${field} must be a non-empty string`);
  }
}

function requireStringArray(
  payload: Record<string, unknown>,
  field: string,
  what: string,
): void {
  const v = payload[field];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`${what} field ${field} must be an array of strings`);
  }
}

/** Structural guards so malformed payloads fail closed with precise errors. */
function assertCandidatePayload(payload: unknown): asserts payload is Candidate {
  if (!isPlainObject(payload)) {
    throw new Error('candidate record payload is not an object');
  }
  if (payload.schema_version !== SEARCH_EPISODE_VERSION) {
    throw new Error(`candidate record has unsupported schema_version`);
  }
  requireNonEmptyString(payload, 'candidate_id', 'candidate record');
  if (!isPlainObject(payload.workspace_revision)) {
    throw new Error('candidate record workspace_revision must be an object');
  }
  requireStringArray(payload, 'mutation_refs', 'candidate record');
  if (!Array.isArray(payload.receipts)) {
    throw new Error('candidate record receipts must be an array');
  }
  if (!CANDIDATE_STATUSES.includes(payload.status as CandidateStatus)) {
    throw new Error(
      `candidate record has unknown status ${String(payload.status)}`,
    );
  }
  requireNonEmptyString(payload, 'created_at', 'candidate record');
}

function assertLineageEdgePayload(
  payload: unknown,
): asserts payload is LineageEdge {
  if (!isPlainObject(payload)) {
    throw new Error('lineage edge record payload is not an object');
  }
  if (payload.schema_version !== SEARCH_EPISODE_VERSION) {
    throw new Error(`lineage edge record has unsupported schema_version`);
  }
  requireNonEmptyString(payload, 'edge_id', 'lineage edge record');
  if (
    !LINEAGE_EDGE_KINDS.includes(payload.kind as LineageEdgeKind)
  ) {
    throw new Error(
      `lineage edge record has unknown kind ${String(payload.kind)}`,
    );
  }
  requireNonEmptyString(payload, 'from_ref', 'lineage edge record');
  requireNonEmptyString(payload, 'to_ref', 'lineage edge record');
  requireNonEmptyString(payload, 'created_at', 'lineage edge record');
}

function assertStatusChangePayload(
  payload: unknown,
): asserts payload is StatusChangePayload {
  if (!isPlainObject(payload)) {
    throw new Error('status change record payload is not an object');
  }
  requireNonEmptyString(payload, 'candidate_id', 'status change record');
  if (!CANDIDATE_STATUSES.includes(payload.status as CandidateStatus)) {
    throw new Error(
      `status change record has unknown status ${String(payload.status)}`,
    );
  }
}

function assertHypothesisPayload(
  payload: unknown,
): asserts payload is HypothesisRecord {
  if (!isPlainObject(payload)) {
    throw new Error('hypothesis record payload is not an object');
  }
  requireNonEmptyString(payload, 'hypothesis_id', 'hypothesis record');
  requireNonEmptyString(payload, 'claim', 'hypothesis record');
  requireNonEmptyString(payload, 'family_id', 'hypothesis record');
  requireStringArray(payload, 'evidence_for', 'hypothesis record');
  requireStringArray(payload, 'evidence_against', 'hypothesis record');
  if (
    !HYPOTHESIS_DISPOSITIONS.includes(
      payload.disposition as HypothesisRecord['disposition'],
    )
  ) {
    throw new Error(
      `hypothesis record has unknown disposition ${String(payload.disposition)}`,
    );
  }
}

function assertSupervisorEventPayload(
  payload: unknown,
): asserts payload is SupervisorEvent {
  if (!isPlainObject(payload)) {
    throw new Error('supervisor event record payload is not an object');
  }
  requireNonEmptyString(payload, 'event_id', 'supervisor event record');
  requireNonEmptyString(payload, 'diagnosis', 'supervisor event record');
  if (
    !Array.isArray(payload.directions) ||
    payload.directions.length < 2 ||
    payload.directions.length > 5
  ) {
    throw new Error(
      `supervisor event ${String(payload.event_id)} must propose 2-5 directions`,
    );
  }
}

/**
 * Order-aware reference checks applied while folding. Supersession must
 * target an already-promoted candidate; promotion and parent edges must
 * anchor to candidates that exist at that point in the log.
 */
function assertEdgeResolvable(episode: SearchEpisode, edge: LineageEdge): void {
  const ids = new Set(episode.candidates.map((c) => c.candidate_id));
  const requireCandidate = (ref: string, role: string): void => {
    if (!ids.has(ref)) {
      throw new Error(
        `lineage edge ${edge.edge_id} references unknown ${role} ${ref}`,
      );
    }
  };
  switch (edge.kind) {
    case 'parent_of':
    case 'forked_from':
      requireCandidate(edge.from_ref, 'parent');
      requireCandidate(edge.to_ref, 'child');
      break;
    case 'promoted_from':
      requireCandidate(edge.from_ref, 'promoted candidate');
      if (edge.to_ref !== LINEAGE_ROOT_REF) {
        requireCandidate(edge.to_ref, 'promotion base');
      }
      break;
    case 'supersedes': {
      requireCandidate(edge.from_ref, 'successor');
      requireCandidate(edge.to_ref, 'displaced best');
      const target = episode.candidates.find(
        (c) => c.candidate_id === edge.to_ref,
      );
      if (
        target !== undefined &&
        target.status !== 'best' &&
        target.status !== 'superseded' &&
        target.status !== 'promoted'
      ) {
        throw new Error(
          `supersedes edge ${edge.edge_id} targets non-promoted candidate ${edge.to_ref}`,
        );
      }
      break;
    }
    default:
      // evaluated_by / score_receipt / rejected_because carry external or
      // label refs (verifier receipt ids, failure classes); only shape is
      // enforced here until evidence-reference hooks land.
      break;
  }
}

export function parseSearchRecordLine(
  line: string,
  lineNumber: number,
): SearchRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`corrupt search episode record at line ${lineNumber}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`malformed search episode record at line ${lineNumber}`);
  }
  const rec = parsed as unknown as SearchRecord;
  if (
    typeof rec.type !== 'string' ||
    typeof rec.recorded_at !== 'string' ||
    rec.recorded_at.length === 0
  ) {
    throw new Error(`malformed search episode record at line ${lineNumber}`);
  }
  if (!SEARCH_RECORD_TYPES.includes(rec.type)) {
    throw new Error(
      `unknown search episode record type "${rec.type}" at line ${lineNumber}`,
    );
  }
  return rec;
}

export function foldSearchRecords(records: SearchRecord[]): SearchEpisode {
  let episode: SearchEpisode | undefined;
  records.forEach((rec, index) => {
    try {
      if (rec.type === 'episode_header') {
        if (episode !== undefined) {
          throw new Error('duplicate episode_header record');
        }
        if (!isPlainObject(rec.payload)) {
          throw new Error('episode_header payload is not an object');
        }
        episode = structuredClone(rec.payload) as unknown as SearchEpisode;
        return;
      }
      if (episode === undefined) {
        throw new Error(
          'search episode records must begin with an episode_header',
        );
      }
      applyRecord(episode, rec);
    } catch (err) {
      throw new Error(
        `search record ${index + 1} (${rec.type}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
  if (episode === undefined) {
    throw new Error('search episode store contains no episode_header');
  }
  // Fail closed on structural violations, EXCEPT the report-only
  // current_best↔status findings (M1): replay must complete deterministically
  // for logs written by ANY writer (including legacy unconditional-reject
  // records); validateSearchEpisode surfaces dangling-best states instead.
  const softFindings = new Set(validateCurrentBestConsistency(episode));
  const fatal = validateSearchEpisode(episode).filter(
    (e) => !softFindings.has(e),
  );
  if (fatal.length > 0) {
    throw new Error(`folded search episode failed validation: ${fatal.join('; ')}`);
  }
  return episode;
}

function applyRecord(episode: SearchEpisode, rec: SearchRecord): void {
  switch (rec.type) {
    case 'episode_header':
      throw new Error('duplicate episode_header record');
    case 'candidate': {
      assertCandidatePayload(rec.payload);
      const cand = structuredClone(rec.payload) as Candidate;
      if (
        episode.candidates.some((c) => c.candidate_id === cand.candidate_id)
      ) {
        throw new Error(`duplicate candidate record for ${cand.candidate_id}`);
      }
      episode.candidates.push(cand);
      break;
    }
    case 'lineage_edge': {
      assertLineageEdgePayload(rec.payload);
      const edge = structuredClone(rec.payload) as LineageEdge;
      if (episode.lineage_edges.some((e) => e.edge_id === edge.edge_id)) {
        throw new Error(`duplicate lineage edge ${edge.edge_id}`);
      }
      assertEdgeResolvable(episode, edge);
      episode.lineage_edges.push(edge);
      break;
    }
    case 'hypothesis': {
      assertHypothesisPayload(rec.payload);
      const hyp = structuredClone(rec.payload) as HypothesisRecord;
      const idx = episode.hypotheses.findIndex(
        (h) => h.hypothesis_id === hyp.hypothesis_id,
      );
      if (idx >= 0) {
        // Sanctioned last-write-wins replay: disposition evolves across the
        // episode; every revision stays recoverable from the JSONL itself.
        episode.hypotheses[idx] = hyp;
      } else {
        episode.hypotheses.push(hyp);
      }
      break;
    }
    case 'score_receipt': {
      const receipt = structuredClone(rec.payload) as ScoreReceipt;
      const errors = validateScoreReceipt(receipt);
      if (errors.length > 0) {
        throw new Error(`invalid score receipt: ${errors.join('; ')}`);
      }
      const cand = episode.candidates.find(
        (c) => c.candidate_id === receipt.candidate_id,
      );
      if (cand === undefined) {
        throw new Error(`score receipt references unknown candidate ${receipt.candidate_id}`);
      }
      if (
        episode.candidates.some((c) =>
          c.receipts.some((r) => r.receipt_id === receipt.receipt_id),
        )
      ) {
        throw new Error(`duplicate score receipt ${receipt.receipt_id}`);
      }
      cand.receipts.push(receipt);
      if (!receipt.correct && cand.status === 'working') {
        cand.status = 'rejected';
      }
      break;
    }
    case 'status_change': {
      assertStatusChangePayload(rec.payload);
      const sc = rec.payload as StatusChangePayload;
      const cand = episode.candidates.find((c) => c.candidate_id === sc.candidate_id);
      if (cand === undefined) {
        throw new Error(`status change references unknown candidate ${sc.candidate_id}`);
      }
      cand.status = sc.status;
      if (sc.status === 'best') {
        episode.search_state.current_best = cand.candidate_id;
      }
      break;
    }
    case 'supervisor_event': {
      assertSupervisorEventPayload(rec.payload);
      episode.supervisor_events.push(structuredClone(rec.payload) as SupervisorEvent);
      break;
    }
  }
}

function readRecords(filePath: string): SearchRecord[] {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((l, i) => parseSearchRecordLine(l, i + 1));
}

export class EpisodeStore {
  private constructor(
    readonly filePath: string,
    private state: SearchEpisode,
  ) {}

  /** Creates a new store file; refuses to overwrite existing episodes. */
  static init(filePath: string, episode: SearchEpisode): EpisodeStore {
    const errors = validateSearchEpisode(episode);
    if (errors.length > 0) {
      throw new Error(`invalid search episode: ${errors.join('; ')}`);
    }
    if (existsSync(filePath)) {
      throw new Error(`search episode store already exists at ${filePath}`);
    }
    mkdirSync(dirname(filePath), { recursive: true });
    const seed = structuredClone(episode);
    const headerRecord: SearchRecord = {
      type: 'episode_header',
      recorded_at: new Date().toISOString(),
      payload: structuredClone(episode),
    };
    appendFileSync(filePath, `${JSON.stringify(headerRecord)}\n`, 'utf-8');
    return new EpisodeStore(filePath, seed);
  }

  static load(filePath: string): EpisodeStore {
    return new EpisodeStore(filePath, foldSearchRecords(readRecords(filePath)));
  }

  get episode(): SearchEpisode {
    return structuredClone(this.state);
  }

  addCandidate(input: NewCandidateInput): Candidate {
    if (
      input.parent_candidate_id !== undefined &&
      !this.state.candidates.some((c) => c.candidate_id === input.parent_candidate_id)
    ) {
      throw new Error(`unknown parent candidate ${input.parent_candidate_id}`);
    }
    const createdAt = new Date().toISOString();
    const candidate: Candidate = {
      schema_version: SEARCH_EPISODE_VERSION,
      candidate_id: newCandidateId(),
      ...(input.parent_candidate_id !== undefined
        ? { parent_candidate_id: input.parent_candidate_id }
        : {}),
      workspace_revision: input.workspace_revision,
      mutation_refs: [...input.mutation_refs],
      ...(input.hypothesis_id !== undefined
        ? { hypothesis_id: input.hypothesis_id }
        : {}),
      receipts: [],
      status: 'working',
      created_at: createdAt,
    };
    this.append({ type: 'candidate', recorded_at: createdAt, payload: candidate });
    if (input.parent_candidate_id !== undefined) {
      this.recordLineageEdge(
        'parent_of',
        input.parent_candidate_id,
        candidate.candidate_id,
      );
    }
    return structuredClone(candidate);
  }

  recordScoreReceipt(receipt: ScoreReceipt): void {
    const errors = validateScoreReceipt(receipt);
    if (errors.length > 0) {
      throw new Error(`invalid score receipt: ${errors.join('; ')}`);
    }
    if (
      this.state.candidates.some((c) =>
        c.receipts.some((r) => r.receipt_id === receipt.receipt_id),
      )
    ) {
      throw new Error(`duplicate score receipt ${receipt.receipt_id}`);
    }
    const target = this.state.candidates.find(
      (c) => c.candidate_id === receipt.candidate_id,
    );
    if (target === undefined) {
      throw new Error(`unknown candidate ${receipt.candidate_id}`);
    }
    // M1 fix — chosen semantics for a late failing receipt: the explicit
    // auto-reject mirrors the fold's implicit rule, so it fires ONLY while
    // the candidate is still 'working'. For 'best'/'promoted'/'superseded'/
    // 'rejected' candidates the failing receipt is recorded as evidence with
    // NO status rewrite: demotion is a controller decision and
    // search_state.current_best is left UNCHANGED (never implicitly cleared).
    // The rejected_because edge stays tied to actual rejections so lineage
    // cannot assert a rejection that did not happen; the validator's
    // current_best-consistency invariant guards the crown.
    const wasWorking = target.status === 'working';
    this.append({
      type: 'score_receipt',
      recorded_at: new Date().toISOString(),
      payload: receipt,
    });
    if (!receipt.correct && wasWorking) {
      this.append({
        type: 'status_change',
        recorded_at: new Date().toISOString(),
        payload: { candidate_id: receipt.candidate_id, status: 'rejected' } satisfies StatusChangePayload,
      });
      this.append({
        type: 'lineage_edge',
        recorded_at: new Date().toISOString(),
        payload: this.makeEdge(
          'rejected_because',
          receipt.candidate_id,
          'failed_evaluation',
        ),
      });
    }
  }

  /**
   * Controller-invoked promotion: crowns the candidate as current best,
   * supersedes any displaced best, and records promotion lineage. Requires
   * at least one correct receipt — policy beyond that belongs to callers.
   */
  promoteCandidate(candidateId: string): void {
    const cand = this.state.candidates.find((c) => c.candidate_id === candidateId);
    if (cand === undefined) {
      throw new Error(`unknown candidate ${candidateId}`);
    }
    if (!cand.receipts.some((r) => r.correct)) {
      throw new Error(`candidate ${candidateId} has no correct receipt; refusing promotion`);
    }
    if (this.state.search_state.current_best === candidateId) {
      return;
    }
    const prevBestId = this.state.search_state.current_best;
    this.append({
      type: 'lineage_edge',
      recorded_at: new Date().toISOString(),
      payload: this.makeEdge(
        'promoted_from',
        candidateId,
        cand.parent_candidate_id ?? 'root',
      ),
    });
    if (prevBestId !== undefined) {
      this.append({
        type: 'lineage_edge',
        recorded_at: new Date().toISOString(),
        payload: this.makeEdge('supersedes', candidateId, prevBestId),
      });
      this.append({
        type: 'status_change',
        recorded_at: new Date().toISOString(),
        payload: { candidate_id: prevBestId, status: 'superseded' } satisfies StatusChangePayload,
      });
    }
    this.append({
      type: 'status_change',
      recorded_at: new Date().toISOString(),
      payload: { candidate_id: candidateId, status: 'best' } satisfies StatusChangePayload,
    });
  }

  recordHypothesis(hypothesis: HypothesisRecord): void {
    this.append({
      type: 'hypothesis',
      recorded_at: new Date().toISOString(),
      payload: hypothesis,
    });
  }

  recordSupervisorEvent(event: SupervisorEvent): void {
    if (event.directions.length < 2 || event.directions.length > 5) {
      throw new Error('supervisor events must propose 2-5 directions');
    }
    this.append({
      type: 'supervisor_event',
      recorded_at: new Date().toISOString(),
      payload: event,
    });
  }

  recordLineageEdge(
    kind: LineageEdgeKind,
    from_ref: string,
    to_ref: string,
    reason?: string,
  ): LineageEdge {
    const edge = this.makeEdge(kind, from_ref, to_ref, reason);
    this.append({ type: 'lineage_edge', recorded_at: edge.created_at, payload: edge });
    return edge;
  }

  private makeEdge(
    kind: LineageEdgeKind,
    from_ref: string,
    to_ref: string,
    reason?: string,
  ): LineageEdge {
    return {
      schema_version: SEARCH_EPISODE_VERSION,
      edge_id: newLineageEdgeId(),
      kind,
      from_ref,
      to_ref,
      ...(reason !== undefined ? { reason } : {}),
      created_at: new Date().toISOString(),
    };
  }

  /**
   * Persists the record and folds the identical object into live state.
   * The record is dry-run folded against a clone first, so a record the
   * loader would reject is never written — the file and live state can
   * never diverge on a failed append.
   */
  private append(record: SearchRecord): void {
    applyRecord(structuredClone(this.state), record);
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf-8');
    applyRecord(this.state, record);
  }
}
