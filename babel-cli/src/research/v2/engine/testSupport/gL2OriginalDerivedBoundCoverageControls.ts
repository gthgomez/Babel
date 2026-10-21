import { createHash } from 'node:crypto'
import type { PassageRecord } from '../../contracts/passages.js'
import type { PlanRevision } from '../../contracts/plan.js'
import type { SourceRecord, SourceRevision } from '../../contracts/sources.js'

/** Labels for B-owned bound-coverage controls (not the immutable live subset). */
export const GL2_BOUND_COVERAGE_CONTROLS_LABEL = 'g-l2-original-derived-bound-coverage-controls/v1'

const cfUrl = 'https://developers.cloudflare.com/cache/concepts/cache-control/'
const mdnUrl = 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control'
const renamedMdnUrl = 'https://cdn-docs.example.net/mdn-mirror/cache-control'

export const gL2NonCacheComparisonQuestion: PlanRevision['questions'][number] = {
  question_id: 'q-g-l2-control-non-cache-comparison',
  text:
    'Do MDN and Cloudflare public documentation describe the same rules for when a 304 Not Modified response may be returned?',
  importance: 'high',
  evidence_requirement: 'Separate developer.mozilla.org and developers.cloudflare.com citations',
  status: 'open',
}

export const gL2RenamedProviderSources: SourceRecord[] = [
  {
    source_id: 'web-mdn-renamed-host',
    kind: 'web',
    canonical_key: renamedMdnUrl,
    observed_urls: [renamedMdnUrl],
    title: 'Renamed-host MDN mirror (not developer.mozilla.org)',
  },
  {
    source_id: 'web-cf-cache-control',
    kind: 'web',
    canonical_key: cfUrl,
    observed_urls: [cfUrl],
    title: 'Cloudflare cache-control',
  },
]

export const gL2RenamedProviderRevisions: SourceRevision[] = [
  {
    revision_id: 'rev-renamed-mdn',
    source_id: 'web-mdn-renamed-host',
    content_hash: createHash('sha256').update('renamed-mdn').digest('hex'),
    retrieved_at: '2026-10-21T11:20:01.000Z',
    extraction_version: 'html-control/v1',
    media_type: 'text/html',
    completeness: 'complete',
    byte_length_received: 900,
  },
  {
    revision_id: 'rev-cf-max-age',
    source_id: 'web-cf-cache-control',
    content_hash: createHash('sha256').update('cf-max-age').digest('hex'),
    retrieved_at: '2026-10-21T11:20:02.000Z',
    extraction_version: 'html-control/v1',
    media_type: 'text/html',
    completeness: 'complete',
    byte_length_received: 1200,
  },
]

export const gL2RenamedProviderPassages: PassageRecord[] = [
  {
    passage_id: 'renamed-mdn:html:0',
    source_revision_id: 'rev-renamed-mdn',
    locator: { kind: 'section', section_id: 'overview' },
    text_ref: {
      mode: 'inline',
      text: 'Cache-Control max-age=86400 for static assets on this mirror.',
      text_hash: createHash('sha256')
        .update('Cache-Control max-age=86400 for static assets on this mirror.')
        .digest('hex'),
    },
  },
  {
    passage_id: 'cf-control:html:0',
    source_revision_id: 'rev-cf-max-age',
    locator: { kind: 'section', section_id: 'expiration' },
    text_ref: {
      mode: 'inline',
      text: 'The max-age directive controls freshness for browser caches.',
      text_hash: createHash('sha256')
        .update('The max-age directive controls freshness for browser caches.')
        .digest('hex'),
    },
  },
]

export const gL2CompleteMaxAgePositiveSources: SourceRecord[] = [
  {
    source_id: 'web-mdn-complete-max-age',
    kind: 'web',
    canonical_key: mdnUrl,
    observed_urls: [mdnUrl],
    title: 'MDN Cache-Control (complete max-age excerpt)',
  },
  {
    source_id: 'web-cf-complete-max-age',
    kind: 'web',
    canonical_key: cfUrl,
    observed_urls: [cfUrl],
    title: 'Cloudflare cache-control (complete)',
  },
]

export const gL2CompleteMaxAgePositiveRevisions: SourceRevision[] = [
  {
    revision_id: 'rev-mdn-complete-max-age',
    source_id: 'web-mdn-complete-max-age',
    content_hash: createHash('sha256').update('mdn-complete-max-age').digest('hex'),
    retrieved_at: '2026-10-21T11:21:01.000Z',
    extraction_version: 'html-control/v1',
    media_type: 'text/html',
    completeness: 'complete',
    byte_length_received: 2400,
  },
  {
    revision_id: 'rev-cf-complete-max-age',
    source_id: 'web-cf-complete-max-age',
    content_hash: createHash('sha256').update('cf-complete-max-age').digest('hex'),
    retrieved_at: '2026-10-21T11:21:02.000Z',
    extraction_version: 'html-control/v1',
    media_type: 'text/html',
    completeness: 'complete',
    byte_length_received: 2400,
  },
]

const mdnCompleteMaxAgeText =
  'For static assets, set Cache-Control: max-age=31536000, immutable so browsers reuse responses.'
const cfCompleteMaxAgeText =
  'Use Cache-Control max-age to control edge TTL separately from browser max-age.'

export const gL2CompleteMaxAgePositivePassages: PassageRecord[] = [
  {
    passage_id: 'mdn-complete:html:0',
    source_revision_id: 'rev-mdn-complete-max-age',
    locator: { kind: 'section', section_id: 'max-age' },
    text_ref: {
      mode: 'inline',
      text: mdnCompleteMaxAgeText,
      text_hash: createHash('sha256').update(mdnCompleteMaxAgeText).digest('hex'),
    },
  },
  {
    passage_id: 'cf-complete:html:0',
    source_revision_id: 'rev-cf-complete-max-age',
    locator: { kind: 'section', section_id: 'max-age' },
    text_ref: {
      mode: 'inline',
      text: cfCompleteMaxAgeText,
      text_hash: createHash('sha256').update(cfCompleteMaxAgeText).digest('hex'),
    },
  },
]
