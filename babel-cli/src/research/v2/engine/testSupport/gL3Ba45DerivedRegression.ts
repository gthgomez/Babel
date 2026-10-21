import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FindingRecord } from '../../contracts/findings.js'
import { FindingRecordSchema } from '../../contracts/findings.js'
import type { PassageRecord } from '../../contracts/passages.js'
import { PassageRecordSchema } from '../../contracts/passages.js'
import type { PlanRevision } from '../../contracts/plan.js'
import { PlanRevisionSchema } from '../../contracts/plan.js'
import type { SourceRecord, SourceRevision } from '../../contracts/sources.js'
import { SourceRecordSchema, SourceRevisionSchema } from '../../contracts/sources.js'
import type { MissionSourceSlotAttribution } from '../sourceAttributionContext.js'

export const GL3_BA45_DERIVED_LABEL = 'g-l3-ba45f328-derived-regression/v1'

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/campaign/g-l3-ba45f328-derived-regression.fixture.json',
)

interface DerivedFixture {
  plan: PlanRevision
  sources: SourceRecord[]
  source_revisions: SourceRevision[]
  passages: PassageRecord[]
  mission_source_slots: MissionSourceSlotAttribution[]
  findings_extract_base: Record<string, FindingRecord>
  findings_historical_final: FindingRecord[]
}

function load(): DerivedFixture {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    plan: unknown
    sources: unknown[]
    source_revisions: unknown[]
    passages: unknown[]
    mission_source_slots: MissionSourceSlotAttribution[]
    findings_extract_base: Record<string, unknown>
    findings_historical_final: unknown[]
  }
  return {
    plan: PlanRevisionSchema.parse(raw.plan),
    sources: raw.sources.map((s) => SourceRecordSchema.parse(s)),
    source_revisions: raw.source_revisions.map((r) => SourceRevisionSchema.parse(r)),
    passages: raw.passages.map((p) => PassageRecordSchema.parse(p)),
    mission_source_slots: raw.mission_source_slots,
    findings_extract_base: Object.fromEntries(
      Object.entries(raw.findings_extract_base).map(([k, f]) => [
        k,
        FindingRecordSchema.parse(f),
      ]),
    ),
    findings_historical_final: raw.findings_historical_final.map((f) =>
      FindingRecordSchema.parse(f),
    ),
  }
}

const derived = load()

export const gL3Ba45Plan = derived.plan
export const gL3Ba45Sources = derived.sources
export const gL3Ba45Revisions = derived.source_revisions
export const gL3Ba45Passages = derived.passages
export const gL3Ba45MissionSourceSlots = derived.mission_source_slots

export const gL3Ba45FindingDownloadsOnly =
  derived.findings_extract_base['finding-a458cc25e3c4633ac9862829']!
export const gL3Ba45FindingFalseDevguideClaim =
  derived.findings_extract_base['finding-f6141bbd69702e076a81e190']!

export const gL3Ba45HistoricalFindings = derived.findings_historical_final

export const SYNTHETIC_REVIEW_LABEL = 'synthetic-derived-review-response/v1'

export function gL3Ba45ReviewContext() {
  return {
    plan: gL3Ba45Plan,
    passages: gL3Ba45Passages,
    sources: gL3Ba45Sources,
    sourceRevisions: gL3Ba45Revisions,
    missionSourceSlots: gL3Ba45MissionSourceSlots,
  }
}
