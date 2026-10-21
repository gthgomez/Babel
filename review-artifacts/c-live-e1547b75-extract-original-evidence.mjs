#!/usr/bin/env node
/**
 * Machine extraction of ORIGINAL persisted store evidence (read-only).
 * Env: BABEL_STORE, BABEL_MISSION_ID, BABEL_CASE (t-l1|g-l3), BABEL_BABEL_CLI_ROOT, BABEL_OUT
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const storeDir = process.env.BABEL_STORE?.trim()
const missionId = process.env.BABEL_MISSION_ID?.trim()
const caseLabel = process.env.BABEL_CASE?.trim() || 'unknown'
const babelCliRoot =
  process.env.BABEL_BABEL_CLI_ROOT?.trim() || '/tmp/babel-validation-prep-e1547b75/babel-cli'
const outPath = process.env.BABEL_OUT?.trim()
if (!storeDir || !missionId || !outPath) {
  console.error('BABEL_STORE, BABEL_MISSION_ID, BABEL_OUT required')
  process.exit(1)
}

const scriptPath = fileURLToPath(import.meta.url)
const scriptBytes = readFileSync(scriptPath)
const scriptSha256 = createHash('sha256').update(scriptBytes).digest('hex')

const distImport = (rel) => import(pathToFileURL(join(babelCliRoot, 'dist', rel)).href)
const { openAdmittedInspectStore } = await distImport('research/v2/control/researchStoreAdmission.js')
const { listFindingsFromStoreEvents } = await distImport(
  'research/v2/engine/listFindingsFromStoreEvents.js',
)

const snapshotPath = join(storeDir, 'research-store.snapshot.json')
const snapshotBytes = readFileSync(snapshotPath)
const snapshotSha256 = createHash('sha256').update(snapshotBytes).digest('hex')

const events = await (await openAdmittedInspectStore(storeDir)).listEvents(missionId)
const findings = listFindingsFromStoreEvents(events)

const missionCreated = events.find((e) => e.kind === 'mission_created')?.payload?.mission
const plans = events.filter((e) => e.kind === 'plan_revised').map((e) => ({
  recorded_at: e.recordedAt,
  plan: e.payload.plan,
}))
const activePlan = plans.at(-1)?.plan

const sources = events.filter((e) => e.kind === 'source_recorded').map((e) => e.payload.source)
const revisions = events.filter((e) => e.kind === 'revision_recorded').map((e) => e.payload.revision)

const sourceById = new Map(sources.map((s) => [s.source_id, s]))

const revisionsWithSlot = revisions.map((rev) => {
  const src = sourceById.get(rev.source_id)
  return {
    ...rev,
    coverage_source_slot: src?.coverage_source_slot ?? null,
    canonical_key: src?.canonical_key ?? null,
    observed_urls: src?.observed_urls ?? null,
  }
})

function sanitizeCompletion(payload) {
  const c = payload?.completion ?? payload
  if (!c || typeof c !== 'object') return c
  const out = structuredClone(c)
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

const passages = events
  .filter((e) => e.kind === 'passage_recorded')
  .map((e) => {
    const p = e.payload.passage
    const ref = p.text_ref
    const base = {
      recorded_at: e.recordedAt,
      passage_id: p.passage_id,
      source_revision_id: p.source_revision_id,
      locator: p.locator,
      heading_path: p.heading_path,
      extraction_notes: p.extraction_notes,
      source_fetch_owner: p.source_fetch_owner,
      host_passage_integrity: p.host_passage_integrity ?? p.passage_integrity ?? null,
    }
    if (ref?.mode === 'inline') {
      return {
        ...base,
        text_ref_mode: 'inline',
        text_hash: ref.text_hash,
        text_byte_length: Buffer.byteLength(ref.text, 'utf8'),
        cited_text: ref.text,
      }
    }
    return { ...base, text_ref: ref }
  })

const findingAudit = findings.map((f) => ({
  finding_id: f.finding_id,
  question_id: f.question_id,
  assertion_text: f.assertion_text,
  assertion_kind: f.assertion_kind,
  passage_ids: f.passage_ids,
  citation_ids: f.citation_ids ?? null,
  source_integrity: f.source_integrity ?? null,
  semantic_support: f.semantic_support ?? null,
  question_coverage: f.question_coverage ?? null,
  plan_obligation_coverage: f.plan_obligation_coverage ?? null,
  claimed_source_attribution: f.claimed_source_attribution ?? null,
  created_at: f.created_at,
  revised_at: f.revised_at ?? null,
}))

const modelReceipts = events
  .filter((e) => e.kind === 'model_invocation_completed')
  .map((e) => ({ recorded_at: e.recordedAt, receipt: e.payload.receipt ?? e.payload }))

const extIntent = events
  .filter((e) => e.kind === 'external_operation_intent')
  .map((e) => ({ recorded_at: e.recordedAt, intent: e.payload.intent ?? e.payload }))

const extCompleted = events
  .filter((e) => e.kind === 'external_operation_completed')
  .map((e) => ({
    recorded_at: e.recordedAt,
    completion: sanitizeCompletion(e.payload),
  }))

const terminal = events.filter((e) => e.kind === 'terminal_receipt').at(-1)?.payload?.report

function costAmount(completion) {
  const c = completion?.completion ?? completion
  const cost = c?.usage_settlement?.cost
  if (!cost || cost.status !== 'reported' || typeof cost.amount_usd !== 'number') return null
  return cost.amount_usd
}

function isModelInvokeCompletion(c) {
  if (c?.operation_kind === 'model_invoke') return true
  const op = String(c?.operation_id ?? '')
  return (
    op.startsWith('cli-run-plan-') ||
    op.startsWith('cli-run-extract-') ||
    op.startsWith('cli-run-review-') ||
    op.startsWith('cli-run-synth-')
  )
}

const modelInvokeCosts = []
const seenOp = new Set()
for (const row of extCompleted) {
  const c = row.completion
  if (!isModelInvokeCompletion(c)) continue
  const key = `${c.operation_id}::${c.attempt_id}`
  if (seenOp.has(key)) continue
  seenOp.add(key)
  const amt = costAmount(row)
  if (amt != null) {
    modelInvokeCosts.push({
      operation_id: c.operation_id,
      attempt_id: c.attempt_id,
      amount_usd_reported: amt,
    })
  }
}
const modelCostSumReportedUsd = modelInvokeCosts.reduce((s, x) => s + x.amount_usd_reported, 0)

let exaEstimateUsd = null
let exaRequestId = null
const seenExa = new Set()
for (const row of extCompleted) {
  const c = row.completion
  const us = c?.usage_settlement
  if (us?.cost?.method === 'exa_lite_estimated_cost_dollars' && typeof us.cost.amount_usd === 'number') {
    const rid =
      c?.search_receipt?.request_id ??
      c?.search_receipt?.exa_request_id ??
      c?.provider_invoke_diagnostics?.inference_id
    const dedupe = rid ?? String(us.cost.amount_usd)
    if (seenExa.has(dedupe)) continue
    seenExa.add(dedupe)
    exaEstimateUsd = us.cost.amount_usd
    exaRequestId = rid ?? null
    break
  }
}

const truncationByRevision = revisionsWithSlot
  .filter((r) => r.completeness === 'truncated' || r.truncation_reason)
  .map((r) => ({
    source_revision_id: r.revision_id,
    source_id: r.source_id,
    canonical_key: r.canonical_key,
    coverage_source_slot: r.coverage_source_slot,
    completeness: r.completeness,
    byte_length_received: r.byte_length_received,
    truncation_reason: r.truncation_reason,
    source_fetch_owner: r.source_fetch_owner,
  }))

const subset = {
  schema: 'research-v2-c-live-original-evidence-export/v1',
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
  extraction: {
    script_path: 'review-artifacts/c-live-e1547b75-extract-original-evidence.mjs',
    script_sha256: scriptSha256,
    command:
      'BABEL_STORE=<store> BABEL_MISSION_ID=<id> BABEL_CASE=<case> BABEL_BABEL_CLI_ROOT=/tmp/babel-validation-prep-e1547b75/babel-cli BABEL_OUT=<out> node review-artifacts/c-live-e1547b75-extract-original-evidence.mjs',
  },
  mission_persisted: missionCreated,
  plan_revisions_all: plans,
  active_plan_latest: activePlan,
  sources,
  source_revisions: revisionsWithSlot,
  truncation_attribution_by_revision: truncationByRevision,
  passages_cited: passages,
  findings: findingAudit,
  model_invocation_completed: modelReceipts,
  external_operation_intents: extIntent,
  external_operation_completions: extCompleted,
  usage_accounting: {
    model_invoke_reported_costs: modelInvokeCosts,
    model_invoke_reported_cost_sum_usd: modelCostSumReportedUsd,
    exa_lite_estimated_cost_usd_once: exaEstimateUsd,
    exa_lite_request_id: exaRequestId,
    note: 'Exa estimate from search completion usage_settlement once; model sum from unique model_invoke completions with cost.status=reported; terminal limitation strings not summed.',
  },
  terminal_receipt: terminal,
  report_cli_note: 'Use store report event or c-live-*-report.json for host report mirror',
}

writeFileSync(outPath, JSON.stringify(subset, null, 2) + '\n')
console.log(JSON.stringify({ outPath, snapshotSha256, findings: findingAudit.length, passages: passages.length }, null, 2))
