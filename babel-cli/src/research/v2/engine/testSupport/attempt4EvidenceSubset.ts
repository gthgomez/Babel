/**
 * Test-only helpers for G-L1 attempt4 historical evidence subset (not production finalization).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FindingRecord } from '../../contracts/findings.js'
import type { PassageRecord } from '../../contracts/passages.js'
import type { SourceRecord, SourceRevision } from '../../contracts/sources.js'
import { FindingRecordSchema } from '../../contracts/findings.js'
import { PassageRecordSchema } from '../../contracts/passages.js'
import { SourceRecordSchema, SourceRevisionSchema } from '../../contracts/sources.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../../..')
export const attempt4EvidenceSubsetPath = join(
  repoRoot,
  'review-artifacts/general-g-l1-attempt4-evidence-subset.json',
)

export interface Attempt4EvidenceSubset {
  source: SourceRecord
  revision: SourceRevision
  passages: PassageRecord[]
  findings: FindingRecord[]
  terminal_report: Record<string, unknown>
  provenance: Record<string, unknown>
}

export function loadAttempt4EvidenceSubset(): Attempt4EvidenceSubset {
  const subset = JSON.parse(readFileSync(attempt4EvidenceSubsetPath, 'utf8'))
  return {
    source: SourceRecordSchema.parse(subset.source),
    revision: SourceRevisionSchema.parse(subset.revision),
    passages: subset.passages.map((p: unknown) => PassageRecordSchema.parse(p)),
    findings: subset.findings.map((f: unknown) => FindingRecordSchema.parse(f)),
    terminal_report: subset.terminal_report as Record<string, unknown>,
    provenance: subset.provenance as Record<string, unknown>,
  }
}
