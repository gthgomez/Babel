import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FindingRecord } from '../../contracts/findings.js'
import type { PassageRecord } from '../../contracts/passages.js'
import type { PlanRevision, ResearchReportV2 } from '../../contracts/plan.js'
import type { SourceRecord, SourceRevision } from '../../contracts/sources.js'
import { FindingRecordSchema } from '../../contracts/findings.js'
import { PassageRecordSchema } from '../../contracts/passages.js'
import { PlanRevisionSchema } from '../../contracts/plan.js'
import { SourceRecordSchema, SourceRevisionSchema } from '../../contracts/sources.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../../..')
export const gL2Diagnostic1EvidenceSubsetPath = join(
  repoRoot,
  'review-artifacts/general-g-l2-diagnostic-1-evidence-subset.json',
)

export type GL2ModelCompletionAccounting = {
  operation_id: string
  attempt_id: string
  completed_at: string
  settlement: string
  usage_settlement: Record<string, unknown>
  provider_invoke_diagnostics: Record<string, unknown>
}

export type GL2Diagnostic1EvidenceSubset = {
  schema_version: string
  campaign_attempt: string
  mission_id: string
  provenance: {
    source_store_snapshot_sha256: string
    extraction_command: string
    read_only_verification_artifacts?: Record<string, string>
  }
  plan_revision: PlanRevision
  model_completions: GL2ModelCompletionAccounting[]
  sources: SourceRecord[]
  revisions: SourceRevision[]
  passages: PassageRecord[]
  findings: FindingRecord[]
  terminal_report: ResearchReportV2
}

export function loadGL2Diagnostic1EvidenceSubset(): GL2Diagnostic1EvidenceSubset {
  const subset = JSON.parse(readFileSync(gL2Diagnostic1EvidenceSubsetPath, 'utf8'))
  return {
    schema_version: String(subset.schema_version),
    campaign_attempt: String(subset.campaign_attempt),
    mission_id: String(subset.mission_id),
    provenance: subset.provenance as GL2Diagnostic1EvidenceSubset['provenance'],
    plan_revision: PlanRevisionSchema.parse(subset.plan_revision),
    model_completions: subset.model_completions as GL2ModelCompletionAccounting[],
    sources: subset.sources.map((s: unknown) => SourceRecordSchema.parse(s)),
    revisions: subset.revisions.map((r: unknown) => SourceRevisionSchema.parse(r)),
    passages: subset.passages.map((p: unknown) => PassageRecordSchema.parse(p)),
    findings: subset.findings.map((f: unknown) => FindingRecordSchema.parse(f)),
    terminal_report: subset.terminal_report as ResearchReportV2,
  }
}
