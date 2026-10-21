#!/usr/bin/env node
/**
 * Machine extraction of ORIGINAL G-L3 store evidence @ ba45f328 (read-only).
 * Usage:
 *   BABEL_G_L3_STORE=/tmp/babel-g-l3-store-ba45f328-1792589570 \
 *   BABEL_G_L3_MISSION_ID=mission-g-l3-validation-ba45f328-001 \
 *   BABEL_G_L3_BABEL_CLI_ROOT=/tmp/babel-g-l3-preflight-ba45f328/babel-cli \
 *   node review-artifacts/g-l3-live-diagnostic-ba45f328-extract-original-subset.mjs \
 *     > review-artifacts/g-l3-live-diagnostic-ba45f328-original-evidence-subset.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const storeDir =
  process.env.BABEL_G_L3_STORE?.trim() || '/tmp/babel-g-l3-store-ba45f328-1792589570'
const missionId =
  process.env.BABEL_G_L3_MISSION_ID?.trim() || 'mission-g-l3-validation-ba45f328-001'
const babelCliRoot =
  process.env.BABEL_G_L3_BABEL_CLI_ROOT?.trim() || '/tmp/babel-g-l3-preflight-ba45f328/babel-cli'
const outPath = process.env.BABEL_G_L3_OUT?.trim() || '-'

const distImport = (rel) => import(pathToFileURL(join(babelCliRoot, 'dist', rel)).href)
const { openAdmittedInspectStore } = await distImport('research/v2/control/researchStoreAdmission.js')
const { listFindingsFromStoreEvents } = await distImport(
  'research/v2/engine/listFindingsFromStoreEvents.js',
)

const snapshotPath = join(storeDir, 'research-store.snapshot.json')
const snapshotBytes = readFileSync(snapshotPath)
const snapshotSha256 = createHash('sha256').update(snapshotBytes).digest('hex')

const inspect = await openAdmittedInspectStore(storeDir)
const events = await inspect.listEvents(missionId)
const findings = listFindingsFromStoreEvents(events)

const sources = events.filter((e) => e.kind === 'source_recorded').map((e) => e.payload.source)
const revisions = events.filter((e) => e.kind === 'revision_recorded').map((e) => e.payload.revision)
const passages = events.filter((e) => e.kind === 'passage_recorded').map((e) => e.payload.passage)
const plans = events.filter((e) => e.kind === 'plan_revised').map((e) => e.payload.plan)
const extCompleted = events.filter((e) => e.kind === 'external_operation_completed')
const extIntent = events.filter((e) => e.kind === 'external_operation_intent')

function sanitizeCompletion(payload) {
  const c = payload?.completion ?? payload
  if (!c || typeof c !== 'object') return payload
  const out = { ...c }
  if (typeof out.body === 'string' && out.body.length > 0) {
    out.body_sha256 = createHash('sha256').update(out.body).digest('hex')
    out.body_byte_length = Buffer.byteLength(out.body, 'utf8')
    delete out.body
  }
  if (typeof out.html === 'string' && out.html.length > 0) {
    out.html_sha256 = createHash('sha256').update(out.html).digest('hex')
    out.html_byte_length = Buffer.byteLength(out.html, 'utf8')
    delete out.html
  }
  delete out.buffer
  return out
}

const completions = extCompleted.map((e) => ({
  recorded_at: e.recordedAt,
  completion: sanitizeCompletion(e.payload),
}))

const passageAudit = passages.map((p) => {
  const ref = p.text_ref
  if (ref?.mode === 'inline') {
    return {
      passage_id: p.passage_id,
      source_revision_id: p.source_revision_id,
      locator: p.locator,
      heading_path: p.heading_path,
      extraction_notes: p.extraction_notes,
      source_fetch_owner: p.source_fetch_owner,
      text_hash: ref.text_hash,
      text_byte_length: Buffer.byteLength(ref.text, 'utf8'),
      cited_text: ref.text,
    }
  }
  return {
    passage_id: p.passage_id,
    source_revision_id: p.source_revision_id,
    locator: p.locator,
    heading_path: p.heading_path,
    text_ref: ref,
  }
})

const findingAudit = findings.map((f) => ({
  finding_id: f.finding_id,
  question_id: f.question_id,
  assertion_text: f.assertion_text,
  assertion_kind: f.assertion_kind,
  passage_ids: f.passage_ids,
  source_integrity: f.source_integrity,
  semantic_support: f.semantic_support ?? null,
  question_coverage: f.question_coverage ?? null,
  plan_obligation_coverage: f.plan_obligation_coverage ?? null,
  created_at: f.created_at,
  revised_at: f.revised_at ?? null,
}))

const webRef1Ops = completions.filter((c) =>
  String(c.completion?.operation_id ?? '').includes('web-ref-1'),
)

const subset = {
  schema: 'research-v2-g-l3-original-evidence-subset/v1',
  mission_id: missionId,
  store_directory: storeDir,
  snapshot: {
    path: snapshotPath,
    byte_length: snapshotBytes.length,
    sha256: snapshotSha256,
  },
  extraction_script: 'review-artifacts/g-l3-live-diagnostic-ba45f328-extract-original-subset.mjs',
  sources,
  revisions,
  plan_revisions: plans,
  findings_final: findingAudit,
  passages: passageAudit,
  external_operation_intents: extIntent.map((e) => ({
    recorded_at: e.recordedAt,
    intent: e.payload,
  })),
  external_operation_completions: completions,
  web_ref_1_completion_subset: webRef1Ops,
}

const text = JSON.stringify(subset, null, 2) + '\n'
if (outPath === '-') {
  process.stdout.write(text)
} else {
  writeFileSync(outPath, text)
}
