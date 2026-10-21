#!/usr/bin/env node
/**
 * Additive supplement: verbatim passage integrity_verification from persisted snapshot only.
 * Does not modify or replace c-live-e1547b75-extract-original-evidence.mjs exports.
 *
 * Env: BABEL_STORE, BABEL_MISSION_ID, BABEL_CASE (t-l1|g-l3), BABEL_OUT
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const storeDir = process.env.BABEL_STORE?.trim()
const missionId = process.env.BABEL_MISSION_ID?.trim()
const caseLabel = process.env.BABEL_CASE?.trim() || 'unknown'
const outPath = process.env.BABEL_OUT?.trim()
if (!storeDir || !missionId || !outPath) {
  console.error('BABEL_STORE, BABEL_MISSION_ID, BABEL_OUT required')
  process.exit(1)
}

const scriptPath = fileURLToPath(import.meta.url)
const scriptSha256 = createHash('sha256').update(readFileSync(scriptPath)).digest('hex')

const snapshotPath = join(storeDir, 'research-store.snapshot.json')
const snapshotBytes = readFileSync(snapshotPath)
const snapshotSha256 = createHash('sha256').update(snapshotBytes).digest('hex')
const snapshot = JSON.parse(snapshotBytes.toString('utf8'))

const events = (snapshot.events ?? []).filter(
  (e) => e.missionId === missionId || e.mission_id === missionId,
)

const passageRows = []
for (const e of events) {
  if (e.kind !== 'passage_recorded') continue
  const p = e.payload?.passage
  if (!p || typeof p !== 'object') continue
  const hasIntegrity = Object.prototype.hasOwnProperty.call(p, 'integrity_verification')
  passageRows.push({
    event_id: e.eventId ?? e.event_id ?? null,
    recorded_at: e.recordedAt ?? e.recorded_at ?? null,
    passage_id: p.passage_id,
    source_revision_id: p.source_revision_id,
    integrity_verification_present_on_record: hasIntegrity,
    integrity_verification: hasIntegrity ? structuredClone(p.integrity_verification) : null,
    wrong_fields_on_record: {
      host_passage_integrity: Object.prototype.hasOwnProperty.call(p, 'host_passage_integrity')
        ? p.host_passage_integrity
        : undefined,
      passage_integrity: Object.prototype.hasOwnProperty.call(p, 'passage_integrity')
        ? p.passage_integrity
        : undefined,
    },
  })
}

const supplement = {
  schema: 'research-v2-c-live-passage-integrity-verification-supplement/v1',
  case: caseLabel,
  bound_commit: 'e1547b756d7de3e41cbad613b95cfc0b62b75af8',
  bound_tree: 'ca8a3d0b4273cbbb84d2acde9dee654129a7b192',
  runtime_binding: {
    execution_cwd: '/tmp/babel-validation-prep-e1547b75/babel-cli',
    bin_absolute: '/tmp/babel-validation-prep-e1547b75/babel-cli/bin/babel.js',
  },
  mission_id: missionId,
  store_directory: storeDir,
  snapshot: {
    path: snapshotPath,
    byte_length: snapshotBytes.length,
    sha256: snapshotSha256,
  },
  corrects_prior_export: {
    prior_export_unchanged:
      caseLabel === 't-l1'
        ? 'review-artifacts/c-live-e1547b75-t-l1-original-evidence-export.json'
        : 'review-artifacts/c-live-e1547b75-g-l3-original-evidence-export.json',
    prior_extractor_script: 'review-artifacts/c-live-e1547b75-extract-original-evidence.mjs',
    prior_extractor_wrong_passage_fields: ['host_passage_integrity', 'passage_integrity'],
    canonical_persisted_passage_field: 'integrity_verification',
    omission_note:
      'Prior export emitted host_passage_integrity null because the extractor read non-canonical keys; that does not establish absent runtime verification on the persisted PassageRecord.',
  },
  extraction: {
    script_path: 'review-artifacts/c-live-e1547b75-extract-passage-integrity-verification-supplement.mjs',
    script_sha256: scriptSha256,
    command:
      'BABEL_STORE=<store> BABEL_MISSION_ID=<id> BABEL_CASE=<case> BABEL_OUT=<out> node review-artifacts/c-live-e1547b75-extract-passage-integrity-verification-supplement.mjs',
    read_method: 'direct_snapshot_json_passage_recorded_events_only',
  },
  receipt_presence_after_reading_records: {
    passage_recorded_events: passageRows.length,
    integrity_verification_present_count: passageRows.filter(
      (r) => r.integrity_verification_present_on_record && r.integrity_verification != null,
    ).length,
    integrity_verification_absent_count: passageRows.filter(
      (r) => !r.integrity_verification_present_on_record || r.integrity_verification == null,
    ).length,
    host_passage_integrity_on_any_record: passageRows.some(
      (r) => r.wrong_fields_on_record.host_passage_integrity !== undefined,
    ),
    passage_integrity_on_any_record: passageRows.some(
      (r) => r.wrong_fields_on_record.passage_integrity !== undefined,
    ),
  },
  passages_integrity_verification_verbatim: passageRows,
}

writeFileSync(outPath, JSON.stringify(supplement, null, 2) + '\n')
console.log(
  JSON.stringify(
    {
      outPath,
      snapshotSha256,
      ...supplement.receipt_presence_after_reading_records,
    },
    null,
    2,
  ),
)
