import type { FindingRecord } from '../contracts/findings.js'
import { QuestionCoverageStatusSchema } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import type { z } from 'zod'

type QuestionCoverageStatus = z.infer<typeof QuestionCoverageStatusSchema>

export type WebSourceClass = 'mdn' | 'cloudflare' | 'other'

export type QuestionCoverageAspect =
  | 'cache_control_max_age'
  | 'audience_browser_vs_edge'
  | 'general'

export interface QuestionCoverageProfile {
  aspect: QuestionCoverageAspect
  /** Cross-source comparison requires relevant admitted evidence per named source class. */
  crossSourceComparison: boolean
  requiredSourceClasses: WebSourceClass[]
}

export interface CitedPassageEvidenceSignals {
  passage_id: string
  source_revision_id: string
  web_source_class: WebSourceClass
  web_domain?: string
  revision_completeness?: SourceRevision['completeness']
  passage_truncated: boolean
  mentions_max_age_or_cache_control: boolean
  mentions_audience_or_reader_role: boolean
}

const HOST_COVERAGE_REVIEWER = 'research-v2-bound-question-coverage'
const HOST_COVERAGE_REVIEWER_VERSION = '0.1.0-admitted-evidence'

const MAX_AGE_OR_CACHE = /\bmax-age\b|max age|cache-control|s-maxage|\bttl\b/i
const AUDIENCE_OR_ROLE =
  /\baudience\b|\breader(s)?\b|written for|intended for|browser(-|\s)?facing|\boperators?\b|who (is|are) (each|the)/i

export function webSourceClassFromHostname(hostname: string): WebSourceClass {
  const host = hostname.toLowerCase()
  if (host === 'developer.mozilla.org' || host.endsWith('.mozilla.org')) {
    return 'mdn'
  }
  if (host === 'developers.cloudflare.com' || host.endsWith('.cloudflare.com')) {
    return 'cloudflare'
  }
  return 'other'
}

export function webSourceClassFromUrl(url: string): WebSourceClass {
  try {
    return webSourceClassFromHostname(new URL(url).hostname)
  } catch {
    return 'other'
  }
}

export function inferQuestionCoverageProfile(
  questionText: string,
  evidenceRequirement?: string,
): QuestionCoverageProfile {
  const text = questionText.toLowerCase()
  const requirement = (evidenceRequirement ?? '').toLowerCase()
  const namesMdn = /\bmdn\b|mozilla/.test(text) || requirement.includes('mozilla')
  const namesCf = /cloudflare/.test(text) || requirement.includes('cloudflare')
  const comparison =
    /\b(agree|differ|compare|comparison|versus|vs\.?)\b/.test(text) ||
    /\bhow do\b.*\bcompare\b/.test(text)
  const maxAgeFocus = MAX_AGE_OR_CACHE.test(text)
  const audienceFocus = AUDIENCE_OR_ROLE.test(text)

  if (namesMdn && namesCf && (comparison || maxAgeFocus)) {
    return {
      aspect: 'cache_control_max_age',
      crossSourceComparison: true,
      requiredSourceClasses: ['mdn', 'cloudflare'],
    }
  }
  if (audienceFocus && !maxAgeFocus) {
    return {
      aspect: 'audience_browser_vs_edge',
      crossSourceComparison: namesMdn && namesCf,
      requiredSourceClasses:
        namesMdn && namesCf ? ['mdn', 'cloudflare'] : namesMdn ? ['mdn'] : namesCf ? ['cloudflare'] : [],
    }
  }
  if (maxAgeFocus) {
    return {
      aspect: 'cache_control_max_age',
      crossSourceComparison: false,
      requiredSourceClasses: [],
    }
  }
  return {
    aspect: 'general',
    crossSourceComparison: false,
    requiredSourceClasses: [],
  }
}

export function buildRevisionProvenanceIndex(
  sources: readonly SourceRecord[],
  revisions: readonly SourceRevision[],
): Map<string, { source: SourceRecord; revision: SourceRevision }> {
  const sourceById = new Map(sources.map((s) => [s.source_id, s]))
  const index = new Map<string, { source: SourceRecord; revision: SourceRevision }>()
  for (const revision of revisions) {
    const source = sourceById.get(revision.source_id)
    if (!source) continue
    index.set(revision.revision_id, { source, revision })
  }
  return index
}

function passageInlineText(passage: PassageRecord): string | undefined {
  if (passage.text_ref.mode !== 'inline') return undefined
  return passage.text_ref.text
}

export function citedPassageEvidenceSignals(
  passage: PassageRecord,
  provenance?: { source: SourceRecord; revision: SourceRevision },
): CitedPassageEvidenceSignals {
  const primaryUrl = provenance?.source.observed_urls[0]
  const webDomain = primaryUrl ? new URL(primaryUrl).hostname : undefined
  const web_source_class = primaryUrl ? webSourceClassFromUrl(primaryUrl) : 'other'
  const text = passageInlineText(passage) ?? ''
  const passage_truncated =
    passage.extraction_notes?.some(
      (n) => n.startsWith('inline_text_truncated:') || n.startsWith('excerpt_truncated'),
    ) === true
  return {
    passage_id: passage.passage_id,
    source_revision_id: passage.source_revision_id,
    web_source_class,
    ...(webDomain ? { web_domain: webDomain } : {}),
    ...(provenance ? { revision_completeness: provenance.revision.completeness } : {}),
    passage_truncated,
    mentions_max_age_or_cache_control: MAX_AGE_OR_CACHE.test(text),
    mentions_audience_or_reader_role: AUDIENCE_OR_ROLE.test(text),
  }
}

export interface BoundCoverageAssessment {
  satisfiesRequiredFacets: boolean
  missingFacets: string[]
  wrongAspectEvidenceOnly: boolean
}

export function assessBoundQuestionCoverageFromAdmittedEvidence(
  profile: QuestionCoverageProfile,
  citedSignals: readonly CitedPassageEvidenceSignals[],
): BoundCoverageAssessment {
  const missingFacets: string[] = []

  if (profile.aspect === 'cache_control_max_age' && profile.crossSourceComparison) {
    for (const sourceClass of profile.requiredSourceClasses) {
      const hasRelevant = citedSignals.some(
        (s) =>
          s.web_source_class === sourceClass &&
          s.mentions_max_age_or_cache_control &&
          !(s.passage_truncated && !s.mentions_max_age_or_cache_control),
      )
      if (!hasRelevant) {
        missingFacets.push(`${sourceClass}_max_age_relevant_evidence`)
      }
    }
  }

  if (profile.aspect === 'audience_browser_vs_edge') {
    const needsAudienceMention = citedSignals.some((s) => s.mentions_audience_or_reader_role)
    const onlyCacheDirectives = citedSignals.some(
      (s) => s.mentions_max_age_or_cache_control && !s.mentions_audience_or_reader_role,
    )
    if (!needsAudienceMention) {
      missingFacets.push('audience_or_reader_role_evidence')
    }
    if (onlyCacheDirectives && !needsAudienceMention) {
      return {
        satisfiesRequiredFacets: false,
        missingFacets,
        wrongAspectEvidenceOnly: true,
      }
    }
    if (profile.crossSourceComparison) {
      for (const sourceClass of profile.requiredSourceClasses) {
        const hasAudience = citedSignals.some(
          (s) => s.web_source_class === sourceClass && s.mentions_audience_or_reader_role,
        )
        if (!hasAudience) {
          missingFacets.push(`${sourceClass}_audience_relevant_evidence`)
        }
      }
    }
  }

  return {
    satisfiesRequiredFacets: missingFacets.length === 0,
    missingFacets,
    wrongAspectEvidenceOnly: false,
  }
}

function downgradeCoverageStatus(
  modelStatus: Exclude<QuestionCoverageStatus, 'not_assessed'>,
  assessment: BoundCoverageAssessment,
): QuestionCoverageStatus {
  if (modelStatus !== 'answers') {
    return modelStatus
  }
  if (assessment.satisfiesRequiredFacets) {
    return 'answers'
  }
  if (assessment.wrongAspectEvidenceOnly) {
    return 'tangential'
  }
  return 'partial'
}

/**
 * Host-side bound on model `question_coverage`: never upgrades; downgrades `answers` when admitted
 * citations do not satisfy required per-source/aspect evidence for the bound plan question.
 */
export function enforceBoundQuestionCoverageOnFindings(
  findings: readonly FindingRecord[],
  params: {
    plan: PlanRevision
    passages: readonly PassageRecord[]
    sources: readonly SourceRecord[]
    sourceRevisions: readonly SourceRevision[]
    reviewedAt: string
  },
): FindingRecord[] {
  const questionById = new Map(params.plan.questions.map((q) => [q.question_id, q]))
  const passageById = new Map(params.passages.map((p) => [p.passage_id, p]))
  const provenanceIndex = buildRevisionProvenanceIndex(params.sources, params.sourceRevisions)

  return findings.map((finding) => {
    const question = questionById.get(finding.question_id)
    if (!question) {
      return finding
    }
    const modelCoverage = finding.question_coverage?.status ?? 'not_assessed'
    if (modelCoverage === 'not_assessed') {
      return finding
    }

    const profile = inferQuestionCoverageProfile(question.text, question.evidence_requirement)
    const citedSignals = finding.passage_ids.flatMap((passageId) => {
      const passage = passageById.get(passageId)
      if (!passage) return []
      const provenance = provenanceIndex.get(passage.source_revision_id)
      return [citedPassageEvidenceSignals(passage, provenance)]
    })

    const assessment = assessBoundQuestionCoverageFromAdmittedEvidence(profile, citedSignals)
    const boundStatus = downgradeCoverageStatus(modelCoverage, assessment)
    if (boundStatus === modelCoverage) {
      return finding
    }

    const missing = assessment.missingFacets.join(',')
    const hostRationale = `Host bound-question coverage: downgraded model "${modelCoverage}" to "${boundStatus}" because admitted citations lack required facet(s): ${missing}.`
    const priorRationale = finding.question_coverage?.rationale ?? ''
    return {
      ...finding,
      question_coverage: {
        status: boundStatus,
        reviewer: HOST_COVERAGE_REVIEWER,
        reviewer_version: HOST_COVERAGE_REVIEWER_VERSION,
        rationale: `${priorRationale} ${hostRationale}`.trim(),
        reviewed_at: params.reviewedAt,
      },
      revised_at: params.reviewedAt,
    }
  })
}
