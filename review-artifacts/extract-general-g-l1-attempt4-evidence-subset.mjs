#!/usr/bin/env node
/**
 * Machine-select sanitized ORIGINAL evidence from the attempt4 durable store snapshot.
 * Excludes model response bodies, credentials, and provider diagnostics.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const defaultSnapshot = join(
  repoRoot,
  'codex/runs/general-g-l1-attempt4/store/research-store.snapshot.json',
)
const defaultOut = join(repoRoot, 'review-artifacts/general-g-l1-attempt4-evidence-subset.json')

const snapshotPath = process.argv[2] ? resolve(process.argv[2]) : defaultSnapshot
const outPath = process.argv[3] ? resolve(process.argv[3]) : defaultOut

const PASSAGE_SUFFIXES = ['html:0', 'html:1', 'html:2', 'html:3', 'html:4', 'html:5']

function passageRank(passageId) {
  const m = /:html:(\d+)$/.exec(passageId)
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY
}

const raw = readFileSync(snapshotPath)
const snapshot = JSON.parse(raw.toString('utf8'))
const snapshotSha256 = createHash('sha256').update(raw).digest('hex')

let source = null
let revision = null
const passages = []
const findingsById = new Map()
let terminalReport = null

for (const event of snapshot.events ?? []) {
  switch (event.kind) {
    case 'source_recorded':
      source = event.payload?.source ?? null
      break
    case 'revision_recorded':
      revision = event.payload?.revision ?? null
      break
    case 'passage_recorded': {
      const passage = event.payload?.passage
      if (!passage?.passage_id) break
      if (PASSAGE_SUFFIXES.some((s) => passage.passage_id.endsWith(`:${s}`))) {
        passages.push(passage)
      }
      break
    }
    case 'finding_recorded': {
      const finding = event.payload?.finding
      if (finding?.finding_id) {
        findingsById.set(finding.finding_id, finding)
      }
      break
    }
    case 'terminal_receipt':
      terminalReport = event.payload?.report ?? null
      break
    default:
      break
  }
}

passages.sort((a, b) => passageRank(a.passage_id) - passageRank(b.passage_id))

const findings = [...findingsById.values()].sort((a, b) =>
  a.finding_id.localeCompare(b.finding_id),
)

if (!source || !revision || passages.length !== 6 || findings.length !== 6 || !terminalReport) {
  console.error(
    'subset incomplete',
    JSON.stringify({
      hasSource: Boolean(source),
      hasRevision: Boolean(revision),
      passageCount: passages.length,
      findingCount: findings.length,
      hasTerminalReport: Boolean(terminalReport),
    }),
  )
  process.exit(1)
}

const extractionCommand = `node review-artifacts/extract-general-g-l1-attempt4-evidence-subset.mjs ${snapshotPath.replace(repoRoot + '/', '')}`

const subset = {
  schema_version: 'research-v2-evidence-subset-v1',
  campaign_attempt: 'general-g-l1-attempt4',
  mission_id: terminalReport.mission_id,
  provenance: {
    source_store_snapshot_path: snapshotPath.replace(repoRoot + '/', ''),
    source_store_snapshot_sha256: snapshotSha256,
    source_revision_content_hash: revision.content_hash,
    extraction_command: extractionCommand,
    extracted_at: new Date().toISOString(),
    sanitization:
      'Original store fields only; no model_invoke bodies; no credentials or HTTP headers.',
  },
  source,
  revision,
  passages,
  findings,
  terminal_report: terminalReport,
}

writeFileSync(outPath, `${JSON.stringify(subset, null, 2)}\n`, 'utf8')
console.log(outPath)
