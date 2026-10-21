import { createHash } from 'node:crypto'
import type { FindingRecord } from '../../contracts/findings.js'
import type { PassageRecord } from '../../contracts/passages.js'
import type { PlanRevision } from '../../contracts/plan.js'
import type { SourceRecord, SourceRevision } from '../../contracts/sources.js'

/**
 * Derived-only regression slice for G-L2 comparison acceptance (not the live source601 snapshot).
 * Labels: `g-l2-audit-derived-regression/v1` — B may publish byte-identical originals separately.
 */
export const GL2_AUDIT_DERIVED_LABEL = 'g-l2-audit-derived-regression/v1'

export const gL2AuditDerivedPlan: PlanRevision = {
  plan_revision_id: 'plan-g-l2-audit-derived',
  mission_id: 'mission-g-l2-constrained-comparison',
  created_at: '2026-10-21T11:05:00.000Z',
  revision_reason: 'derived_audit_q3_q4_coverage',
  questions: [
    {
      question_id: 'q-g-l2-audit-3',
      text:
        'Do MDN and Cloudflare public documentation agree or differ on Cache-Control max-age guidance for caching static assets?',
      importance: 'critical',
      evidence_requirement: 'Separate developer.mozilla.org and developers.cloudflare.com citations',
      status: 'open',
    },
    {
      question_id: 'q-g-l2-audit-4',
      text:
        'Who is each document written for — browser-facing developers versus edge/CDN operators?',
      importance: 'critical',
      evidence_requirement: 'Keep browser vs edge/CDN roles explicit per source',
      status: 'open',
    },
  ],
}

const mdnUrl = 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching'
const cfUrl = 'https://developers.cloudflare.com/cache/concepts/cache-control/'

export const gL2AuditDerivedSources: SourceRecord[] = [
  {
    source_id: 'web-mdn-cache-derived',
    kind: 'web',
    canonical_key: mdnUrl,
    observed_urls: [mdnUrl],
    title: 'MDN HTTP Caching (truncated overview excerpt)',
  },
  {
    source_id: 'web-cf-cache-derived',
    kind: 'web',
    canonical_key: cfUrl,
    observed_urls: [cfUrl],
    title: 'Cloudflare cache-control concepts',
  },
]

export const gL2AuditDerivedRevisions: SourceRevision[] = [
  {
    revision_id: 'rev-mdn-derived-trunc',
    source_id: 'web-mdn-cache-derived',
    content_hash: createHash('sha256').update('mdn-trunc-overview').digest('hex'),
    retrieved_at: '2026-10-21T11:00:01.000Z',
    extraction_version: 'html-derived/v1',
    media_type: 'text/html',
    completeness: 'truncated',
    byte_length_received: 1200,
    truncation_reason: 'host_decoded_byte_limit',
  },
  {
    revision_id: 'rev-cf-derived-complete',
    source_id: 'web-cf-cache-derived',
    content_hash: createHash('sha256').update('cf-max-age-complete').digest('hex'),
    retrieved_at: '2026-10-21T11:00:02.000Z',
    extraction_version: 'html-derived/v1',
    media_type: 'text/html',
    completeness: 'complete',
    byte_length_received: 4800,
  },
]

const mdnTruncatedOverview =
  'The HTTP cache stores responses associated with requests. This overview introduces cache storage concepts.'
const cfMaxAge =
  'Cache-Control max-age directive controls how long a response may be cached before revalidation is required.'

export const gL2AuditDerivedPassages: PassageRecord[] = [
  {
    passage_id: 'fetch-mdn-derived:html:0',
    source_revision_id: 'rev-mdn-derived-trunc',
    locator: { kind: 'section', section_id: 'overview' },
    text_ref: {
      mode: 'inline',
      text: mdnTruncatedOverview,
      text_hash: createHash('sha256').update(mdnTruncatedOverview).digest('hex'),
    },
    extraction_notes: ['inline_text_truncated:host_decoded_byte_limit'],
  },
  {
    passage_id: 'fetch-cf-derived:html:0',
    source_revision_id: 'rev-cf-derived-complete',
    locator: { kind: 'section', section_id: 'cache-control' },
    text_ref: {
      mode: 'inline',
      text: cfMaxAge,
      text_hash: createHash('sha256').update(cfMaxAge).digest('hex'),
    },
  },
]

/** Mirrors live audit finding7f3 shape: supported Cloudflare max-age + truncated MDN without max-age. */
export const gL2AuditDerivedFindingQ3: FindingRecord = {
  finding_id: 'finding-g-l2-audit-q3-7f3-derived',
  question_id: 'q-g-l2-audit-3',
  assertion_text:
    'Cloudflare documents max-age at the edge; MDN caching overview was retrieved but does not state max-age in the admitted excerpt.',
  assertion_kind: 'source_observation',
  passage_ids: ['fetch-cf-derived:html:0', 'fetch-mdn-derived:html:0'],
  source_integrity: 'not_checked',
  created_at: '2026-10-21T11:00:10.000Z',
}

export const gL2AuditDerivedFindingQ4WrongAspect: FindingRecord = {
  finding_id: 'finding-g-l2-audit-q4-wrong-aspect-derived',
  question_id: 'q-g-l2-audit-4',
  assertion_text: 'Cache-Control max-age applies to browser caches and CDN edge caches alike.',
  assertion_kind: 'source_observation',
  passage_ids: ['fetch-cf-derived:html:0'],
  source_integrity: 'not_checked',
  created_at: '2026-10-21T11:00:11.000Z',
}

export function gL2AuditDerivedModelReviewClaimingAnswersFor(
  findingId: string,
): Record<string, unknown> {
  return {
    kind: 'semantic_support_review',
    judgments: [
      {
        finding_id: findingId,
        status: 'supported',
        rationale: 'Model incorrectly labels coverage as answers (derived audit defect reproduction).',
        question_coverage: 'answers',
      },
    ],
  }
}

export const gL2AuditDerivedModelReviewBothClaimingAnswers = {
  kind: 'semantic_support_review' as const,
  judgments: [
    {
      finding_id: gL2AuditDerivedFindingQ3.finding_id,
      status: 'supported' as const,
      rationale: 'Model incorrectly labels comparison answered despite missing MDN max-age excerpt.',
      question_coverage: 'answers' as const,
    },
    {
      finding_id: gL2AuditDerivedFindingQ4WrongAspect.finding_id,
      status: 'supported' as const,
      rationale: 'Model treats cache directives as audience coverage.',
      question_coverage: 'answers' as const,
    },
  ],
}
