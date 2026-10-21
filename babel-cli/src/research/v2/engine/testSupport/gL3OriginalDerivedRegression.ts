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

export const GL3_ORIGINAL_DERIVED_LABEL = 'g-l3-original-derived-regression/v1'

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/campaign/g-l3-original-derived-regression.fixture.json',
)

interface FixtureSlice {
  plan: PlanRevision
  sources: SourceRecord[]
  source_revisions: SourceRevision[]
  passages: PassageRecord[]
  findings: Record<string, FindingRecord>
}

function loadSlice(key: string): FixtureSlice {
  const root = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>
  const raw = root[key]
  if (!raw || typeof raw !== 'object') {
    throw new Error(`missing fixture slice ${key}`)
  }
  const slice = raw as {
    plan: unknown
    sources: unknown[]
    source_revisions: unknown[]
    passages: unknown[]
    findings: Record<string, unknown>
  }
  return {
    plan: PlanRevisionSchema.parse(slice.plan),
    sources: slice.sources.map((s) => SourceRecordSchema.parse(s)),
    source_revisions: slice.source_revisions.map((r) => SourceRevisionSchema.parse(r)),
    passages: slice.passages.map((p) => PassageRecordSchema.parse(p)),
    findings: Object.fromEntries(
      Object.entries(slice.findings).map(([k, f]) => [k, FindingRecordSchema.parse(f)]),
    ),
  }
}

const crossPage = loadSlice('cross_page_attribution_defect')
const renamedSlot = loadSlice('renamed_slot_control')

export const gL3OriginalDerivedPlan = crossPage.plan
export const gL3OriginalDerivedSources = crossPage.sources
export const gL3OriginalDerivedRevisions = crossPage.source_revisions
export const gL3OriginalDerivedPassages = crossPage.passages
export const gL3OriginalDerivedFindingFalseAgreement =
  crossPage.findings.cross_page_false_agreement!
export const gL3OriginalDerivedFindingInsufficientHonest =
  crossPage.findings.cross_page_insufficient_honest!

export const gL3RenamedSlotPlan = renamedSlot.plan
export const gL3RenamedSlotSources = renamedSlot.sources
export const gL3RenamedSlotRevisions = renamedSlot.source_revisions
export const gL3RenamedSlotPassages = renamedSlot.passages
export const gL3RenamedSlotFindingWrongMet = renamedSlot.findings.wrong_slot_met!

export function gL3FalseAgreementModelReview(): Record<string, unknown> {
  return {
    kind: 'semantic_support_review',
    judgments: [
      {
        finding_id: gL3OriginalDerivedFindingFalseAgreement.finding_id,
        status: 'supported',
        rationale: 'Table and landing agree.',
        question_coverage: 'answers',
        obligation_coverage: [
          {
            obligation_id: 'ob-downloads-stable-version-date',
            status: 'met',
            supporting_passage_ids: ['fetch-downloads-original-derived:html:4'],
          },
          {
            obligation_id: 'ob-devguide-stable-version-date',
            status: 'met',
            supporting_passage_ids: ['fetch-downloads-original-derived:html:4'],
          },
        ],
      },
    ],
  }
}

export function gL3InsufficientHonestModelReview(): Record<string, unknown> {
  return {
    kind: 'semantic_support_review',
    judgments: [
      {
        finding_id: gL3OriginalDerivedFindingInsufficientHonest.finding_id,
        status: 'supported',
        rationale: 'Downloads admitted; devguide missing.',
        question_coverage: 'partial',
        obligation_coverage: [
          {
            obligation_id: 'ob-downloads-stable-version-date',
            status: 'met',
            supporting_passage_ids: ['fetch-downloads-original-derived:html:4'],
          },
          {
            obligation_id: 'ob-devguide-stable-version-date',
            status: 'unmet',
          },
        ],
      },
    ],
  }
}
