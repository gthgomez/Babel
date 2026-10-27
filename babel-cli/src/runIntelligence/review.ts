import { existsSync, statSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { catalogReference, lookupReviewEntity } from './reviewLookup.js'
import { DatabaseSync } from 'node:sqlite'

export interface ReviewOptions { until?: string; lastHours?: number }
const assessments = new Set(['ESTABLISHED_PASS', 'ESTABLISHED_FAIL', 'UNKNOWN', 'CONFLICTED', 'INVALID_EVIDENCE', 'NOT_APPLICABLE', 'SAFE_REFUSAL', 'INFRA_FAILURE'])
const categories = new Set(['TOOL_CALL_ERROR', 'TRANSPORT', 'TIMEOUT', 'RATE_LIMIT', 'SERVER_ERROR', 'STREAM_IDLE', 'RESPONSE_NORMALIZATION', 'PROVIDER_FAILURE'])
function records(db: DatabaseSync, sql: string, ...args: Array<string | number>): Array<Record<string, unknown>> {
  return db.prepare(sql).all(...args) as Array<Record<string, unknown>>
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
function token(value: unknown, prefix: string): string | null {
  return typeof value === 'string' && new RegExp(`^${prefix}_[0-9a-f-]+$`).test(value) ? value : null
}

function parseUntil(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return NaN
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number]
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month < 1 || month > 12 || day < 1 || day > days[month - 1]! || hour > 23 || minute > 59 || second > 59 ? NaN : Date.parse(value)
}

/** Build a bounded, deterministic review from existing derived facts only. */
export function buildRunReview(db: DatabaseSync, options: ReviewOptions = {}) {
  const hours = options.lastHours ?? 24
  const end = options.until === undefined ? Date.now() : parseUntil(options.until)
  if (!Number.isFinite(end) || end - hours * 3600000 < -8640000000000000 || !Number.isFinite(hours) || hours <= 0 || hours > 8760)
    throw new Error('Review requires a valid --until timestamp and --last-hours in (0, 8760]')
  const until = new Date(end).toISOString()
  const since = new Date(end - hours * 3600000).toISOString()
  const selected = records(db, `SELECT r.logical_id AS run_id,r.receipt_id,strftime('%Y-%m-%dT%H:%M:%fZ',r.captured_at) AS captured_at,t.logical_id AS trial_id,
    a.assessment FROM run_containers r JOIN trials t ON t.run_id=r.logical_id
    LEFT JOIN task_outcome_assessments a ON a.trial_id=t.logical_id
    WHERE julianday(r.captured_at)>=julianday(?) AND julianday(r.captured_at)<julianday(?)
    ORDER BY julianday(r.captured_at),r.logical_id LIMIT 1001`, since, until)
  const truncated = selected.length > 1000
  const runs = selected.slice(0, 1000).map(row => {
    const runId = String(row['run_id'])
    const trialId = String(row['trial_id'])
    const metadata = records(db, "SELECT value_json FROM annotations WHERE entity_id=? AND annotation_type='bri.review-context.v1' ORDER BY created_at,annotation_id", runId)
      .map(r => object(r['value_json'])).find(r => r['receiptId'] === row['receipt_id']) ?? {}
    const corrections = records(db, "SELECT annotation_id,value_json FROM annotations WHERE entity_id=? AND annotation_type='bri.assessment-correction.v1' ORDER BY rowid LIMIT 51", trialId).map(r => {
      const data = object(r['value_json'])
      return { correctionId: String(r['annotation_id']), evaluationVersionToken: token(data['evaluationVersionRef'], 'evaluation_version'),
        verdict: ['PASS', 'FAIL', 'UNKNOWN'].includes(String(data['verdict'])) ? String(data['verdict']) : 'UNKNOWN',
        kind: data['correctionKind'] === 'EVALUATOR_ERROR' ? 'EVALUATOR_ERROR' : 'EVIDENCE_UPDATE',
        externalEvidenceToken: token(data['evidenceRef'], 'evidence'), referenceAvailability: 'EXTERNAL_REFERENCE_WITHHELD', status: 'REVIEW_ONLY' }
    })
    const evaluatorCorrectionRecorded = records(db, `SELECT 1 FROM annotations WHERE entity_id=? AND annotation_type='bri.assessment-correction.v1'
      AND CASE WHEN json_valid(value_json) THEN json_extract(value_json,'$.correctionKind') END='EVALUATOR_ERROR' LIMIT 1`, trialId).length > 0
    const evidence = records(db, 'SELECT observation_id,dimension,validity,revision_binding,authority FROM outcome_observations WHERE trial_id=? ORDER BY observation_id LIMIT 21', trialId)
    const cost = records(db, `SELECT COUNT(*) AS observations,SUM(CASE WHEN u.cost_usd IS NULL OR u.availability<>'PRESENT' THEN 1 ELSE 0 END) AS missing
      FROM usage_observations u JOIN execution_segments s ON s.segment_id=u.segment_id WHERE s.trial_id=?`, trialId)[0]!
    const assessment = assessments.has(String(row['assessment'])) ? String(row['assessment']) : 'UNKNOWN'
    return { runId, trialId, sourceRef: String(row['receipt_id']), capturedAt: new Date(String(row['captured_at'])).toISOString(),
      taskToken: token(metadata['taskToken'], 'task'), assessment,
      confidence: assessment.startsWith('ESTABLISHED_') ? 'REVISION_BOUND_TASK_EVIDENCE' : 'NOT_ESTABLISHED',
      evaluatorCorrectionRecorded,
      correctionReview: corrections.length ? 'REQUIRES_REVIEW_ORIGINAL_RETAINED' : 'NONE_RECORDED',
      evidenceRefs: evidence.slice(0, 20).map(e => String(e['observation_id'])), evidenceRefsTruncated: evidence.length > 20,
      corrections: corrections.slice(0, 50), correctionsTruncated: corrections.length > 50,
      friction: { providerRetriesScheduled: count(metadata['retries']), completionBlocks: count(metadata['completionBlocks']), clarifications: null },
      cost: Number(cost['observations']) > 0 && Number(cost['missing']) === 0 ? 'RECORDED_NOT_AGGREGATED' : 'UNKNOWN' }
  })
  const findings = new Map<string, {
    clusterId: string; signatureId: string; category: string; occurrences: number; runRefs: string[];
    taskTokens: Set<string>; failedTaskRefs: Set<string>; unattributedRuns: number;
    status: string; suspectedCauseRecorded: boolean; resolution: string;
    reviewedFixRef: string | null; lineage: Array<{ edgeRef: string; relation: string; from: ReturnType<typeof catalogReference>; to: ReturnType<typeof catalogReference> }>;
    lineageTruncated: boolean;
  }>()
  for (const run of runs) {
    const failures = records(db, `SELECT c.*,s.category,COUNT(*) AS occurrences FROM failure_occurrences f
      JOIN failure_signatures s ON s.signature_id=f.signature_id JOIN failure_clusters c ON c.signature_id=f.signature_id
      WHERE f.trial_id=? GROUP BY c.cluster_id`, run.trialId)
    for (const f of failures) {
      const clusterId = String(f['cluster_id'])
      let finding = findings.get(clusterId)
      if (!finding) {
        finding = { clusterId, signatureId: String(f['signature_id']), category: categories.has(String(f['category'])) ? String(f['category']) : 'REDACTED', occurrences: 0,
          runRefs: [], taskTokens: new Set(), failedTaskRefs: new Set(), unattributedRuns: 0,
          status: f['validated_fix'] ? 'VALIDATION_RECORDED_UNVERIFIED' : f['candidate_fix'] ? 'CANDIDATE_RECORDED' : f['suspected_cause'] ? 'INVESTIGATION_RECORDED' : 'NEEDS_INVESTIGATION',
          suspectedCauseRecorded: Boolean(f['suspected_cause']), resolution: 'NOT_ESTABLISHED',
          reviewedFixRef: f['validated_fix'] || f['candidate_fix'] ? clusterId : null,
          lineageTruncated: Number(records(db, 'SELECT COUNT(*) AS n FROM lineage_edges WHERE from_id=? OR to_id=?', clusterId, clusterId)[0]?.['n'] ?? 0) > 20,
          lineage: records(db, 'SELECT edge_id,relation,from_id,to_id FROM lineage_edges WHERE from_id=? OR to_id=? ORDER BY created_at,edge_id LIMIT 20', clusterId, clusterId)
            .map(e => ({ edgeRef: String(e['edge_id']), relation: String(e['relation']), from: catalogReference(db, String(e['from_id'])), to: catalogReference(db, String(e['to_id'])) })) }
        findings.set(clusterId, finding)
      }
      finding.occurrences += Number(f['occurrences'])
      finding.runRefs.push(run.runId)
      if (run.taskToken) {
        finding.taskTokens.add(run.taskToken)
        // A corrected evaluator failure requires investigation rather than product-failure promotion.
        if (run.assessment === 'ESTABLISHED_FAIL' && !run.evaluatorCorrectionRecorded) finding.failedTaskRefs.add(run.taskToken)
      } else finding.unattributedRuns++
    }
  }
  const ranked = [...findings.values()].map(({ taskTokens, failedTaskRefs, ...f }) => ({ ...f, distinctTasks: taskTokens.size, failedDistinctTasks: failedTaskRefs.size,
    nextAction: f.status === 'VALIDATION_RECORDED_UNVERIFIED' ? `Inspect recorded validation with babel runs show ${f.clusterId}; review linked task evidence and check recurrence independently` : `Investigate with babel runs show ${f.clusterId}; compare supporting task evidence before choosing a repair` }))
    .sort((a, b) => b.failedDistinctTasks - a.failedDistinctTasks || b.distinctTasks - a.distinctTasks || a.clusterId.localeCompare(b.clusterId))
  return { schemaVersion: 'bri.batch-review.v1', window: { since, until, basis: 'run captured_at; start inclusive, end exclusive' },
    summary: { runs: runs.length, distinctTasks: new Set(runs.flatMap(r => r.taskToken ? [r.taskToken] : [])).size,
      unattributedRuns: runs.filter(r => !r.taskToken).length,
      establishedPassRuns: runs.filter(r => r.assessment === 'ESTABLISHED_PASS').length,
      establishedFailRuns: runs.filter(r => r.assessment === 'ESTABLISHED_FAIL').length,
      unknownOutcomeRuns: runs.filter(r => r.assessment === 'UNKNOWN').length,
      otherOutcomeRuns: runs.filter(r => !['ESTABLISHED_PASS', 'ESTABLISHED_FAIL', 'UNKNOWN'].includes(r.assessment)).length,
      missingCostRuns: runs.filter(r => r.cost === 'UNKNOWN').length,
      undatedRunsExcluded: Number(records(db, 'SELECT COUNT(*) AS n FROM run_containers WHERE julianday(captured_at) IS NULL')[0]?.['n'] ?? 0) },
    truncated, ranking: 'failed distinct tasks DESC (evaluator corrections excluded), affected distinct tasks DESC, cluster ID ASC',
    warnings: ['Cluster counts overlap; do not add them. Retry occurrences are not independent tasks.',
      'Original assessments are retained; corrections and recorded fixes are review-only assertions.',
      'Task outcome, cost, clarification and before/after coverage is incomplete. No live re-execution or automatic action.',
      ...(truncated ? ['Only the first 1000 runs are included; narrow the time window.'] : [])],
    findings: ranked, runs }
}
export type RunReview = ReturnType<typeof buildRunReview>

function withImmutableCatalog<T>(path: string, read: (db: DatabaseSync) => T): T {
  const selectedPath = realpathSync.native(resolve(path))
  const pendingWal = (): boolean => existsSync(`${selectedPath}-wal`) && statSync(`${selectedPath}-wal`).size > 0
  if (pendingWal()) throw new Error('Review requires a checkpointed catalog; close inventory or other writers and retry')
  const before = statSync(selectedPath, { bigint: true })
  if (before.nlink > 1n) throw new Error('Review refuses catalog files with hardlink aliases; use an independent checkpointed copy')
  // immutable=1 avoids SQLite's otherwise writable WAL/shared-memory reader sidecars.
  // It ignores WAL frames, so live/pending WAL is rejected before and after the read.
  const db = new DatabaseSync(`${pathToFileURL(selectedPath).href}?immutable=1`, { readOnly: true })
  try {
    const report = read(db)
    const after = statSync(selectedPath, { bigint: true })
    if (pendingWal() || ['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after]))
      throw new Error('Catalog changed during review; close writers and retry with a checkpointed catalog')
    return report
  } finally { db.close() }
}

/** Open an existing checkpointed catalog without migrations, writes or SQLite sidecars. */
export function reviewCatalog(path: string, options: ReviewOptions = {}): RunReview {
  return withImmutableCatalog(path, db => buildRunReview(db, options))
}

/** Resolve a minimized review reference through the same immutable reader. */
export function showCatalogEntity(path: string, entityId: string): Record<string, unknown> | null {
  return withImmutableCatalog(path, db => lookupReviewEntity(db, entityId))
}

/** Render the same minimized facts for ordinary terminal use. */
export function formatRunReview(report: RunReview): string {
  return [
    `Run review ${report.window.since} to ${report.window.until}`,
    `${report.summary.runs} runs; ${report.summary.distinctTasks} distinct identified tasks; ${report.summary.unattributedRuns} unattributed runs`,
    `Task evidence: ${report.summary.establishedPassRuns} PASS / ${report.summary.establishedFailRuns} FAIL / ${report.summary.unknownOutcomeRuns} UNKNOWN / ${report.summary.otherOutcomeRuns} other-assessment runs; missing cost: ${report.summary.missingCostRuns}`,
    `Ranking: ${report.ranking}`,
    ...report.findings.map((f, i) => `${i + 1}. ${f.category}: ${f.distinctTasks} tasks / ${f.occurrences} occurrences; ${f.status}; resolution ${f.resolution}\n   ${f.clusterId}\n   runs: ${f.runRefs.join(', ')}\n   fix reference: ${f.reviewedFixRef ?? 'none'}; recorded lineage links ${f.lineage.length}${f.lineageTruncated ? ' (truncated)' : ''}\n   ${f.nextAction}`),
    ...report.runs.map(r => `${r.runId}: ${r.assessment} (${r.confidence}); retry schedules ${r.friction.providerRetriesScheduled ?? 'UNKNOWN'}; completion blocks ${r.friction.completionBlocks ?? 'UNKNOWN'}; clarifications UNKNOWN; cost ${r.cost}; corrections ${r.corrections.map(c => `${c.verdict}:${c.kind}:${c.status}`).join(', ') || 'none'}; source ${r.sourceRef}${r.evidenceRefsTruncated || r.correctionsTruncated ? '; references truncated' : ''}`),
    ...report.warnings,
  ].join('\n')
}
