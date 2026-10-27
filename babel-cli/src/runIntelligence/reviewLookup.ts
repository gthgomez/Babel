import type { DatabaseSync } from 'node:sqlite'
import { opaqueId } from './contracts.js'

function one(db: DatabaseSync, sql: string, id: string): Record<string, unknown> | undefined {
  return db.prepare(sql).get(id) as Record<string, unknown> | undefined
}
function refs(db: DatabaseSync, sql: string, id: string): string[] {
  return (db.prepare(sql).all(id) as Array<{ ref: string }>).map(row => row.ref)
}

/** Resolve a lineage target only when an existing minimized CLI entity owns it. */
export function catalogReference(db: DatabaseSync, value: string): { entityRef: string | null; referenceToken: string } {
  const known = /^(?:run|trial|receipt|fs|cluster|outcome|correction|edge)_[a-f0-9-]{24,36}$/.test(value) && db.prepare(`
    SELECT 1 FROM run_containers WHERE logical_id=? UNION ALL SELECT 1 FROM trials WHERE logical_id=?
    UNION ALL SELECT 1 FROM extraction_receipts WHERE receipt_id=? UNION ALL SELECT 1 FROM failure_signatures WHERE signature_id=?
    UNION ALL SELECT 1 FROM failure_clusters WHERE cluster_id=? UNION ALL SELECT 1 FROM outcome_observations WHERE observation_id=?
    UNION ALL SELECT 1 FROM annotations WHERE annotation_id=? AND annotation_type='bri.assessment-correction.v1'
    UNION ALL SELECT 1 FROM lineage_edges WHERE edge_id=? LIMIT 1`).get(...Array<string>(8).fill(value))
  return { entityRef: known ? value : null, referenceToken: opaqueId('reference', value) }
}

/** Look up existing review evidence without exposing source paths, diagnostic bodies or free-text reviews. */
export function lookupReviewEntity(db: DatabaseSync, id: string): Record<string, unknown> | null {
  const run = one(db, 'SELECT logical_id,source_namespace,source_schema,captured_at,receipt_id AS source_ref,source_digest IS NOT NULL AS digest_available FROM run_containers WHERE logical_id=?', id)
  if (run) return { ...run, entityType: 'run', trialRefs: refs(db, 'SELECT logical_id AS ref FROM trials WHERE run_id=? ORDER BY logical_id LIMIT 50', id) }
  const signature = one(db, 'SELECT signature_id,algorithm_version,subsystem,category,stable_detail FROM failure_signatures WHERE signature_id=?', id)
  if (signature) return signature
  const receipt = one(db, 'SELECT receipt_id,source_locator_digest,source_digest IS NOT NULL AS digest_available FROM extraction_receipts WHERE receipt_id=?', id)
  if (receipt) return { entityType: 'extraction_receipt', ...receipt,
    runRefs: refs(db, 'SELECT logical_id AS ref FROM run_containers WHERE receipt_id=? ORDER BY logical_id LIMIT 50', id),
    sourceLocation: 'WITHHELD; use the original inventory root and locator digest',
    nextAction: 'Inspect the linked run and its observation references; source paths and bodies remain local to the original evidence store' }
  const trial = one(db, 'SELECT logical_id AS trial_id,run_id FROM trials WHERE logical_id=?', id)
  if (trial) return { entityType: 'trial', ...trial,
    observationRefs: refs(db, 'SELECT observation_id AS ref FROM outcome_observations WHERE trial_id=? ORDER BY observation_id LIMIT 20', id),
    correctionRefs: refs(db, "SELECT annotation_id AS ref FROM annotations WHERE entity_id=? AND annotation_type='bri.assessment-correction.v1' ORDER BY rowid LIMIT 50", id),
    assessment: one(db, 'SELECT assessment,policy_version FROM task_outcome_assessments WHERE trial_id=?', id) ?? null,
    scope: 'Original assessment; corrections do not rewrite the grade. Reference lists are bounded.' }
  const cluster = one(db, `SELECT cluster_id,signature_id AS signature_ref,adjudication IS NOT NULL AS adjudication_recorded,
    suspected_cause IS NOT NULL AS suspected_cause_recorded,candidate_fix IS NOT NULL AS candidate_fix_recorded,
    validated_fix IS NOT NULL AS validated_fix_recorded FROM failure_clusters WHERE cluster_id=?`, id)
  if (cluster) return { entityType: 'failure_cluster', ...cluster, reviewStatus: 'REVIEW_ONLY', resolution: 'NOT_ESTABLISHED',
    runRefs: refs(db, `SELECT DISTINCT t.run_id AS ref FROM failure_occurrences f JOIN trials t ON t.logical_id=f.trial_id
      JOIN failure_clusters c ON c.signature_id=f.signature_id WHERE c.cluster_id=? ORDER BY t.run_id LIMIT 50`, id),
    lineageRefs: refs(db, 'SELECT edge_id AS ref FROM lineage_edges WHERE from_id=?1 OR to_id=?1 ORDER BY rowid LIMIT 20', id),
    scope: 'All catalog evidence, outside the batch time window; reference lists are bounded. Cause/fix prose is withheld.',
    nextAction: 'Inspect signature, supporting runs and lineage; obtain independent task-specific validation before choosing or certifying a repair' }
  const observation = one(db, `SELECT observation_id,trial_id,dimension,value,validity,availability,authority,revision_binding FROM outcome_observations WHERE observation_id=?`, id)
  if (observation) return { entityType: 'outcome_observation', observationRef: id, trialRef: observation['trial_id'],
    dimension: ['VERIFIER_RESULT','CONTROL_DECISION','TERMINAL_EXECUTION_STATUS','TEST_CORRECTNESS','TASK_CORRECTNESS'].includes(String(observation['dimension'])) ? observation['dimension'] : 'UNKNOWN',
    value: ['PASS','FAIL','MISSING','UNKNOWN','ALLOWED','DENIED'].includes(String(observation['value'])) ? observation['value'] : 'WITHHELD',
    valid: observation['validity'] === 'VALID', available: observation['availability'] === 'PRESENT',
    authority: ['DETERMINISTIC_VERIFICATION','INDEPENDENT_VERIFICATION'].includes(String(observation['authority'])) ? observation['authority'] : 'NON_TASK_AUTHORITY',
    revisionBound: observation['revision_binding'] === 'BOUND', taskCorrectness: observation['dimension'] === 'TASK_CORRECTNESS' }
  const correction = one(db, "SELECT entity_id,value_json FROM annotations WHERE annotation_id=? AND annotation_type='bri.assessment-correction.v1'", id)
  if (correction) {
    let data: Record<string, unknown> = {}
    try { data = JSON.parse(String(correction['value_json'])) as Record<string, unknown> } catch { /* Invalid metadata never yields diagnostic bodies. */ }
    return { entityType: 'assessment_correction', correctionRef: id, trialRef: correction['entity_id'], status: 'REVIEW_ONLY',
      verdict: ['PASS','FAIL','UNKNOWN'].includes(String(data?.['verdict'])) ? data['verdict'] : 'UNKNOWN',
      evaluatorErrorRecorded: data?.['correctionKind'] === 'EVALUATOR_ERROR',
      originalAssessment: 'RETAINED; no independent certification is implied' }
  }
  const edge = one(db, 'SELECT edge_id,from_id,to_id,relation FROM lineage_edges WHERE edge_id=?', id)
  if (edge) return { entityType: 'lineage_assertion', edgeRef: id, relation: edge['relation'], status: 'REVIEW_ONLY',
    from: catalogReference(db, String(edge['from_id'])), to: catalogReference(db, String(edge['to_id'])),
    externalTargets: 'Null entityRef means no catalog lookup is available; raw external reference is withheld' }
  return null
}
