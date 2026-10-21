import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import { passageRecordsWithSourceAttribution } from './claimedSourceAttribution.js'
import type { MissionSourceSlotAttribution } from './sourceAttributionContext.js'

export function buildSynthesizeReportModelInput(
  findings: readonly FindingRecord[],
  options?: {
    mission_source_slots?: readonly MissionSourceSlotAttribution[]
    passages?: readonly PassageRecord[]
    sources?: readonly SourceRecord[]
    sourceRevisions?: readonly SourceRevision[]
  },
): {
  mission_source_slots?: readonly MissionSourceSlotAttribution[]
  passages?: ReturnType<typeof passageRecordsWithSourceAttribution>
  findings: Array<{
    finding_id: string
    question_id: string
    assertion_text: string
    passage_ids: string[]
    semantic_support: NonNullable<FindingRecord['semantic_support']>['status'] | 'not_checked'
    claimed_source_attribution:
      | NonNullable<FindingRecord['claimed_source_attribution']>['status']
      | 'not_assessed'
    claimed_source_slots: string[]
    question_coverage: NonNullable<FindingRecord['question_coverage']>['status'] | 'not_assessed'
  }>
} {
  const attributedPassages =
    options?.passages && options.sources && options.sourceRevisions
      ? passageRecordsWithSourceAttribution(
          options.passages,
          options.sources,
          options.sourceRevisions,
        )
      : undefined

  return {
    ...(options?.mission_source_slots
      ? { mission_source_slots: options.mission_source_slots }
      : {}),
    ...(attributedPassages ? { passages: attributedPassages } : {}),
    findings: findings.map((finding) => ({
      finding_id: finding.finding_id,
      question_id: finding.question_id,
      assertion_text: finding.assertion_text,
      passage_ids: [...finding.passage_ids],
      semantic_support: finding.semantic_support?.status ?? 'not_checked',
      claimed_source_attribution:
        finding.claimed_source_attribution?.status ?? 'not_assessed',
      claimed_source_slots: finding.claimed_source_attribution?.source_slots ?? [],
      question_coverage: finding.question_coverage?.status ?? 'not_assessed',
    })),
  }
}
