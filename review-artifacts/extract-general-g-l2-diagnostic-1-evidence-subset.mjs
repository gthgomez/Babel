#!/usr/bin/env node
/**
 * Sanitized ORIGINAL evidence from G-L2 diagnostic-1 durable store snapshot.
 * No model bodies, credentials, HTTP headers, or provider diagnostics.
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

const raw = readFileSync(snapshotPath)
const snapshot = JSON.parse(raw.toString('utf8'))
const snapshotSha256 = createHash('sha256').update(raw).digest('hex')

const missionId = 'mission-g-l2-general-live-diagnostic-1'
const sourcesById = new Map()
const revisionsBySourceId = new Map()
const passagesById = new Map()
const findingsById = new Map()
let terminalReport = null

for (const event of snapshot.events ?? []) {
  if (event.missionId !== missionId) continue
  switch (event.kind) {
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

const citationIds = [...(terminalReport.citation_passage_ids ?? [])].sort()
const passages = citationIds.map((id) => {
  const p = passagesById.get(id)
  if (!p) throw new Error(`missing cited passage ${id}`)
  return p
})

const sourceIds = [...new Set(passages.map((p) => {
  const rev = [...revisionsBySourceId.values()].find((r) => r.revision_id === p.source_revision_id)
  return rev?.source_id
}).filter(Boolean))].sort()

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

const extractionCommand = `node review-artifacts/extract-general-g-l2-diagnostic-1-evidence-subset.mjs ${snapshotPath.replace(repoRoot + '/', '')}`

const subset = {
  schema_version: 'research-v2-evidence-subset-v1',
  campaign_attempt: 'general-g-l2-diagnostic-1',
  mission_id: missionId,
  provenance: {
    source_store_snapshot_path: snapshotPath.replace(repoRoot + '/', ''),
    source_store_snapshot_sha256: snapshotSha256,
    live_run_receipt: 'review-artifacts/general-g-l2-diagnostic-1-live-run-receipt.json',
    extraction_command: extractionCommand,
    extracted_at: new Date().toISOString(),
    sanitization:
      'Original store fields for cited passages and final findings only; no model_invoke bodies; no credentials, HTTP headers, or provider diagnostics; semantic review rationales retained as stored (not re-run).',
  },
  sources,
  revisions,
  passages,
  findings,
  terminal_report: terminalReport,
}

writeFileSync(outPath, `${JSON.stringify(subset, null, 2)}\n`, 'utf8')
console.log(outPath)
console.log('snapshot_sha256', snapshotSha256)
console.log('cited_passages', passages.length)
console.log('findings', findings.length)
