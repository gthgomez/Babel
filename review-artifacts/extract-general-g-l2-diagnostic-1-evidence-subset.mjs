#!/usr/bin/env node
/**
 * Sanitized ORIGINAL evidence from G-L2 diagnostic-1 durable store snapshot.
 * Includes plan questions, final findings (with review rationales), cited passages,
 * and allowlisted model accounting. No model response bodies or reasoning streams.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const defaultSnapshot = join(
  repoRoot,
  'codex/runs/general-g-l2-diagnostic-1/store/research-store.snapshot.json',
)
const defaultOut = join(repoRoot, 'review-artifacts/general-g-l2-diagnostic-1-evidence-subset.json')

const snapshotPath = process.argv[2] ? resolve(process.argv[2]) : defaultSnapshot
const outPath = process.argv[3] ? resolve(process.argv[3]) : defaultOut

const MODEL_OPERATION_PREFIXES = [
  'cli-run-plan-',
  'cli-run-extract-',
  'cli-run-review-',
  'cli-run-synth-',
]

function sanitizeProviderDiagnostics(diag) {
  if (!diag || typeof diag !== 'object') return {}
  return {
    normalized_finish_reason: diag.normalized_finish_reason,
    visible_content_present: diag.visible_content_present,
    output_digest: diag.output_digest,
    input_tokens: diag.input_tokens,
    output_tokens: diag.output_tokens,
    reasoning_tokens: diag.reasoning_tokens,
    provider_request_id: diag.provider_request_id ?? null,
  }
}

function sanitizeUsageSettlement(usage) {
  if (!usage || typeof usage !== 'object') return {}
  const out = {
    attempt_id: usage.attempt_id,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    reasoning_tokens: usage.reasoning_tokens,
  }
  if (usage.cost && typeof usage.cost === 'object') {
    out.cost = {
      status: usage.cost.status,
      amount_usd: usage.cost.amount_usd,
      currency: usage.cost.currency,
    }
  }
  return out
}

const raw = readFileSync(snapshotPath)
const snapshot = JSON.parse(raw.toString('utf8'))
const snapshotSha256 = createHash('sha256').update(raw).digest('hex')

const missionId = 'mission-g-l2-general-live-diagnostic-1'
const sourcesById = new Map()
const revisionsBySourceId = new Map()
const passagesById = new Map()
const findingsById = new Map()
const plansByRevisionId = new Map()
const completionsByOperationId = new Map()
let terminalReport = null

for (const event of snapshot.events ?? []) {
  if (event.missionId !== missionId) continue
  switch (event.kind) {
    case 'plan_revised': {
      const plan = event.payload?.plan
      if (plan?.plan_revision_id) plansByRevisionId.set(plan.plan_revision_id, plan)
      break
    }
    case 'source_recorded': {
      const source = event.payload?.source
      if (source?.source_id) sourcesById.set(source.source_id, source)
      break
    }
    case 'revision_recorded': {
      const revision = event.payload?.revision
      if (revision?.source_id) revisionsBySourceId.set(revision.source_id, revision)
      break
    }
    case 'passage_recorded': {
      const passage = event.payload?.passage
      if (passage?.passage_id) passagesById.set(passage.passage_id, passage)
      break
    }
    case 'finding_recorded': {
      const finding = event.payload?.finding
      if (finding?.finding_id) findingsById.set(finding.finding_id, finding)
      break
    }
    case 'external_operation_completed': {
      const completion = event.payload?.completion
      const opId = completion?.operation_id
      if (opId) completionsByOperationId.set(opId, completion)
      break
    }
    case 'terminal_receipt':
      terminalReport = event.payload?.report ?? null
      break
    default:
      break
  }
}

if (!terminalReport) {
  console.error('missing terminal_receipt')
  process.exit(1)
}

const activePlan = plansByRevisionId.get(terminalReport.plan_revision_id)
if (!activePlan?.questions?.length) {
  console.error('missing active plan for terminal report', terminalReport.plan_revision_id)
  process.exit(1)
}

const citationIds = [...(terminalReport.citation_passage_ids ?? [])].sort()
const passages = citationIds.map((id) => {
  const p = passagesById.get(id)
  if (!p) throw new Error(`missing cited passage ${id}`)
  return p
})

const sourceIds = [
  ...new Set(
    passages
      .map((p) => {
        const rev = [...revisionsBySourceId.values()].find((r) => r.revision_id === p.source_revision_id)
        return rev?.source_id
      })
      .filter(Boolean),
  ),
].sort()

const sources = sourceIds.map((id) => {
  const s = sourcesById.get(id)
  if (!s) throw new Error(`missing source ${id}`)
  return s
})
const revisions = sourceIds.map((id) => {
  const r = revisionsBySourceId.get(id)
  if (!r) throw new Error(`missing revision for ${id}`)
  return r
})

const findings = [...findingsById.values()].sort((a, b) => a.finding_id.localeCompare(b.finding_id))

const model_completions = MODEL_OPERATION_PREFIXES
  .map((prefix) => {
    const opId = [...completionsByOperationId.keys()].find((id) => id.startsWith(prefix))
    if (!opId) return null
    const completion = completionsByOperationId.get(opId)
    return {
      operation_id: completion.operation_id,
      attempt_id: completion.attempt_id,
      completed_at: completion.completed_at,
      settlement: completion.settlement,
      usage_settlement: sanitizeUsageSettlement(completion.usage_settlement),
      provider_invoke_diagnostics: sanitizeProviderDiagnostics(completion.provider_invoke_diagnostics),
    }
  })
  .filter(Boolean)

if (model_completions.length !== 4) {
  console.error('expected 4 model completions', model_completions.length)
  process.exit(1)
}

const extractionCommand = `node review-artifacts/extract-general-g-l2-diagnostic-1-evidence-subset.mjs ${snapshotPath.replace(repoRoot + '/', '')}`

const subset = {
  schema_version: 'research-v2-evidence-subset-v1',
  campaign_attempt: 'general-g-l2-diagnostic-1',
  mission_id: missionId,
  provenance: {
    source_store_snapshot_path: snapshotPath.replace(repoRoot + '/', ''),
    source_store_snapshot_sha256: snapshotSha256,
    live_run_receipt: 'review-artifacts/general-g-l2-diagnostic-1-live-run-receipt.json',
    read_only_verification_artifacts: {
      build_stdout_log: 'review-artifacts/general-g-l2-diagnostic-1-build.stdout.log',
      pre_run_fingerprints: 'review-artifacts/general-g-l2-diagnostic-1-pre-run-fingerprints.json',
      campaign_preflight_stdout: 'review-artifacts/general-g-l2-diagnostic-1-preflight.json',
    },
    extraction_command: extractionCommand,
    extracted_at: new Date().toISOString(),
    sanitization:
      'Original store fields only; plan questions and final findings (including assertion and review rationales as stored); cited passages; allowlisted model completion/accounting (operation/attempt IDs, settlement, token and cost metadata, output_digest, finish reason flags). No model response bodies, reasoning streams, credentials, or HTTP headers.',
  },
  plan_revision: {
    plan_revision_id: activePlan.plan_revision_id,
    mission_id: activePlan.mission_id,
    created_at: activePlan.created_at,
    revision_reason: activePlan.revision_reason,
    questions: activePlan.questions,
  },
  model_completions,
  sources,
  revisions,
  passages,
  findings,
  terminal_report: terminalReport,
}

writeFileSync(outPath, `${JSON.stringify(subset, null, 2)}\n`, 'utf8')
console.log(outPath)
console.log('snapshot_sha256', snapshotSha256)
console.log('plan_questions', activePlan.questions.length)
console.log('model_completions', model_completions.length)
console.log('cited_passages', passages.length)
console.log('findings', findings.length)
