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

/**
 * Labelled original-derived G-L2 replay bytes (B may publish byte-identical JSON).
 * Questions and defect-replay passage text are frozen; host coverage uses plan `coverage_obligations`.
 */
export const GL2_ORIGINAL_DERIVED_LABEL = 'g-l2-original-derived-regression/v1'

/** @deprecated Use {@link GL2_ORIGINAL_DERIVED_LABEL} — alias for prior derived label in tests. */
export const GL2_AUDIT_DERIVED_LABEL = GL2_ORIGINAL_DERIVED_LABEL

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/campaign/g-l2-original-derived-regression.fixture.json',
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

const cacheDefect = loadSlice('cache_comparison_defect')
const renamedSlot = loadSlice('renamed_slot_cache_comparison')
const nonCache = loadSlice('non_cache_comparison')

export const gL2OriginalDerivedPlan = cacheDefect.plan
export const gL2OriginalDerivedSources = cacheDefect.sources
export const gL2OriginalDerivedRevisions = cacheDefect.source_revisions
export const gL2OriginalDerivedPassages = cacheDefect.passages

export const gL2OriginalDerivedFindingQ3_7f3 = cacheDefect.findings.q3_7f3!
export const gL2OriginalDerivedFindingQ4_a0cf = cacheDefect.findings.q4_a0cf!
export const gL2OriginalDerivedFindingQ3Positive = cacheDefect.findings.q3_positive_control!
export const gL2OriginalDerivedFindingQ4Positive = cacheDefect.findings.q4_positive_control!

export const gL2RenamedSlotPlan = renamedSlot.plan
export const gL2RenamedSlotSources = renamedSlot.sources
export const gL2RenamedSlotRevisions = renamedSlot.source_revisions
export const gL2RenamedSlotPassages = renamedSlot.passages
export const gL2RenamedSlotFindingPartial = renamedSlot.findings.compare_partial!

export const gL2NonCachePlan = nonCache.plan
export const gL2NonCacheSources = nonCache.sources
export const gL2NonCacheRevisions = nonCache.source_revisions
export const gL2NonCachePassages = nonCache.passages
export const gL2NonCacheFindingInsufficient = nonCache.findings.api_compare_insufficient!

/** Back-compat aliases for tests that imported the pre-original derived module names. */
export const gL2AuditDerivedPlan = gL2OriginalDerivedPlan
export const gL2AuditDerivedSources = gL2OriginalDerivedSources
export const gL2AuditDerivedRevisions = gL2OriginalDerivedRevisions
export const gL2AuditDerivedPassages = gL2OriginalDerivedPassages
export const gL2AuditDerivedFindingQ3 = gL2OriginalDerivedFindingQ3_7f3
export const gL2AuditDerivedFindingQ4WrongAspect = gL2OriginalDerivedFindingQ4_a0cf

function q3ObligationCoverageDefectReplay(): Record<string, unknown>[] {
  return [
    {
      obligation_id: 'ob-mdn-max-age-semantics',
      status: 'met',
      supporting_passage_ids: ['fetch-mdn-original-derived:html:overview'],
    },
    {
      obligation_id: 'ob-cf-max-age-semantics',
      status: 'met',
      supporting_passage_ids: ['fetch-cf-original-derived:html:max-age'],
    },
  ]
}

function q4ObligationCoverageWrongAspect(): Record<string, unknown>[] {
  return [
    {
      obligation_id: 'ob-mdn-audience',
      status: 'wrong_aspect',
      supporting_passage_ids: ['fetch-cf-original-derived:html:max-age'],
    },
    {
      obligation_id: 'ob-cf-audience',
      status: 'wrong_aspect',
      supporting_passage_ids: ['fetch-cf-original-derived:html:max-age'],
    },
  ]
}

function q3ObligationCoveragePositive(): Record<string, unknown>[] {
  return [
    {
      obligation_id: 'ob-mdn-max-age-semantics',
      status: 'met',
      supporting_passage_ids: ['fetch-mdn-original-derived:html:max-age'],
    },
    {
      obligation_id: 'ob-cf-max-age-semantics',
      status: 'met',
      supporting_passage_ids: ['fetch-cf-original-derived:html:max-age'],
    },
  ]
}

function q4ObligationCoveragePositive(): Record<string, unknown>[] {
  return [
    {
      obligation_id: 'ob-mdn-audience',
      status: 'met',
      supporting_passage_ids: ['fetch-mdn-original-derived:html:audience'],
    },
    {
      obligation_id: 'ob-cf-audience',
      status: 'met',
      supporting_passage_ids: ['fetch-cf-original-derived:html:audience'],
    },
  ]
}

export function gL2AuditDerivedModelReviewClaimingAnswersFor(
  findingId: string,
): Record<string, unknown> {
  const obligation_coverage =
    findingId === gL2OriginalDerivedFindingQ3_7f3.finding_id
      ? q3ObligationCoverageDefectReplay()
      : findingId === gL2OriginalDerivedFindingQ4_a0cf.finding_id
        ? q4ObligationCoverageWrongAspect()
        : undefined
  return {
    kind: 'semantic_support_review',
    judgments: [
      {
        finding_id: findingId,
        status: 'supported',
        rationale: 'Model incorrectly labels coverage as answers (original-derived defect replay).',
        question_coverage: 'answers',
        ...(obligation_coverage ? { obligation_coverage } : {}),
      },
    ],
  }
}

export const gL2AuditDerivedModelReviewBothClaimingAnswers = {
  kind: 'semantic_support_review' as const,
  judgments: [
    {
      finding_id: gL2OriginalDerivedFindingQ3_7f3.finding_id,
      status: 'supported' as const,
      rationale: 'Model incorrectly labels comparison answered despite missing MDN max-age substance.',
      question_coverage: 'answers' as const,
      obligation_coverage: q3ObligationCoverageDefectReplay(),
    },
    {
      finding_id: gL2OriginalDerivedFindingQ4_a0cf.finding_id,
      status: 'supported' as const,
      rationale: 'Model treats cache directives as audience coverage.',
      question_coverage: 'answers' as const,
      obligation_coverage: q4ObligationCoverageWrongAspect(),
    },
  ],
}

export function gL2PositiveControlModelReview(): Record<string, unknown> {
  return {
    kind: 'semantic_support_review',
    judgments: [
      {
        finding_id: gL2OriginalDerivedFindingQ3Positive.finding_id,
        status: 'supported',
        rationale: 'Both slots document max-age semantics in admitted excerpts.',
        question_coverage: 'answers',
        obligation_coverage: q3ObligationCoveragePositive(),
      },
      {
        finding_id: gL2OriginalDerivedFindingQ4Positive.finding_id,
        status: 'supported',
        rationale: 'Audience roles are explicit per source.',
        question_coverage: 'answers',
        obligation_coverage: q4ObligationCoveragePositive(),
      },
    ],
  }
}
