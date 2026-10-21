import type { PassageRecord } from '../contracts/passages.js'
import type { PlanCoverageObligation, QuestionRecord } from '../contracts/plan.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'

const MAX_AGE_OR_TTL_SUBSTANCE = /\bmax-age\b|\bmax age\b|s-maxage|\bttl\b/i
const AUTHENTICATION_MECHANISM_SUBSTANCE =
  /\b(authorization|bearer|oauth|api[- ]?key|authenticate|authentication|auth(?:entication)? token)\b/i
const AUDIENCE_INTENT_SUBSTANCE =
  /\baudience\b|written for|intended for|\bwrote this guide for\b|\breader(s)?\b|browser(-|\s)?facing|\boperators?\b|who (is|are) (each|the|this)/i

export interface CitedPassageProvenance {
  passage: PassageRecord
  source?: SourceRecord
  revision?: SourceRevision
}

export interface ObligationEvidenceAssessment {
  satisfiesAllObligations: boolean
  missingObligationIds: string[]
  wrongAspectOnly: boolean
}

function passageText(passage: PassageRecord): string {
  if (passage.text_ref.mode !== 'inline') return ''
  return passage.text_ref.text
}

export function passageSupportsTechnicalEffect(
  text: string,
  effect: NonNullable<PlanCoverageObligation['technical_effect']>,
): boolean {
  if (effect === 'max_age_or_ttl_semantics') {
    return MAX_AGE_OR_TTL_SUBSTANCE.test(text)
  }
  if (effect === 'authentication_mechanism') {
    return AUTHENTICATION_MECHANISM_SUBSTANCE.test(text)
  }
  return text.trim().length > 0
}

export function passageSupportsAudienceIntent(text: string): boolean {
  return AUDIENCE_INTENT_SUBSTANCE.test(text)
}

export function passageSupportsObligation(
  text: string,
  obligation: PlanCoverageObligation,
): boolean {
  if (obligation.aspect === 'audience_intent') {
    return passageSupportsAudienceIntent(text)
  }
  const kind = obligation.technical_effect ?? 'general_technical'
  return passageSupportsTechnicalEffect(text, kind)
}

export function assessPlanCoverageObligations(
  obligations: readonly PlanCoverageObligation[],
  cited: readonly CitedPassageProvenance[],
): ObligationEvidenceAssessment {
  const missingObligationIds: string[] = []
  let sawTechnicalOnlyForAudience = false

  for (const obligation of obligations) {
    const slotPassages = cited.filter((c) => c.source?.coverage_source_slot === obligation.source_slot)
    const satisfied = slotPassages.some((entry) =>
      passageSupportsObligation(passageText(entry.passage), obligation),
    )
    if (!satisfied) {
      missingObligationIds.push(obligation.obligation_id)
    }
    if (obligation.aspect === 'audience_intent') {
      const anyTechnical = slotPassages.some((entry) => {
        const text = passageText(entry.passage)
        return passageSupportsTechnicalEffect(text, 'max_age_or_ttl_semantics') &&
          !passageSupportsAudienceIntent(text)
      })
      const anyAudience = slotPassages.some((entry) =>
        passageSupportsAudienceIntent(passageText(entry.passage)),
      )
      if (anyTechnical && !anyAudience) {
        sawTechnicalOnlyForAudience = true
      }
    }
  }

  return {
    satisfiesAllObligations: missingObligationIds.length === 0,
    missingObligationIds,
    wrongAspectOnly: sawTechnicalOnlyForAudience && missingObligationIds.length > 0,
  }
}

export function obligationsForQuestion(question: QuestionRecord): PlanCoverageObligation[] {
  return question.coverage_obligations ?? []
}

export function buildCitedPassageProvenance(
  passageIds: readonly string[],
  passageById: ReadonlyMap<string, PassageRecord>,
  provenanceIndex: ReadonlyMap<string, { source: SourceRecord; revision: SourceRevision }>,
): CitedPassageProvenance[] {
  const cited: CitedPassageProvenance[] = []
  for (const passageId of passageIds) {
    const passage = passageById.get(passageId)
    if (!passage) continue
    const provenance = provenanceIndex.get(passage.source_revision_id)
    cited.push({
      passage,
      ...(provenance ? { source: provenance.source, revision: provenance.revision } : {}),
    })
  }
  return cited
}
