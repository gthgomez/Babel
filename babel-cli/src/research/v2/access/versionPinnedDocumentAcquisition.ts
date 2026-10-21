import { createHash } from 'node:crypto'
import type { SourceRecord } from '../contracts/sources.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import campaignPins from '../fixtures/campaign/T-L1-T-L2-PINNED-VERSIONS.json' with { type: 'json' }
import paperManifest from '../fixtures/campaign/papers/1706.03762.manifest.json' with { type: 'json' }

/** Document-specific admitted-byte ceiling (does not raise global web DEFAULT_MAX). */
export interface VersionPinnedDocumentAcquisitionPolicy {
  policy_id: string
  canonical_urls: readonly string[]
  wire_byte_limit: number
  decompressed_byte_limit: number
  expected_content_sha256: string
  expected_byte_length: number
  require_complete_body: true
  provenance: {
    arxiv_id: string
    title: string
    manifest_schema: string
    recorded_at: string
  }
}

export const T_L2_VERSION_PINNED_PAPER_POLICY: VersionPinnedDocumentAcquisitionPolicy = {
  policy_id: 't-l2-arxiv-1706.03762',
  canonical_urls: [campaignPins.t_l2_paper.canonical_url, paperManifest.canonical_url],
  wire_byte_limit: paperManifest.wire_byte_limit,
  decompressed_byte_limit: paperManifest.decompressed_byte_limit,
  expected_content_sha256: paperManifest.content_sha256,
  expected_byte_length: paperManifest.byte_length,
  require_complete_body: true,
  provenance: {
    arxiv_id: paperManifest.arxiv_id,
    title: paperManifest.title,
    manifest_schema: paperManifest.schema,
    recorded_at: paperManifest.recorded_at,
  },
}

const POLICIES: readonly VersionPinnedDocumentAcquisitionPolicy[] = [
  T_L2_VERSION_PINNED_PAPER_POLICY,
]

function normalizeUrl(url: string): string {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

export function findVersionPinnedDocumentPolicy(
  source: SourceRecord,
): VersionPinnedDocumentAcquisitionPolicy | undefined {
  if (source.kind !== 'document' && source.kind !== 'paper') {
    return undefined
  }
  const keys = new Set<string>([
    normalizeUrl(source.canonical_key),
    ...source.observed_urls.map(normalizeUrl),
  ])
  return POLICIES.find((policy) =>
    policy.canonical_urls.some((url) => keys.has(normalizeUrl(url))),
  )
}

/** Per-source fetch limit; undefined keeps port default (200k general web cap). */
export function resolveFetchAdmittedByteLimitForSource(
  source: SourceRecord,
  _mission?: ResearchMissionV2,
): number | undefined {
  const policy = findVersionPinnedDocumentPolicy(source)
  if (!policy) return undefined
  return Math.max(policy.wire_byte_limit, policy.decompressed_byte_limit)
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export type VersionPinnedAdmissionVerdict =
  | { ok: true }
  | {
      ok: false
      failureCategory: 'truncated' | 'policy_denied'
      message: string
    }

/** Enforce complete-body + recorded digest for version-pinned campaign PDFs. */
export function verifyVersionPinnedDocumentAdmission(
  source: SourceRecord,
  admittedBytes: Buffer,
  truncated: boolean,
): VersionPinnedAdmissionVerdict {
  const policy = findVersionPinnedDocumentPolicy(source)
  if (!policy) {
    return { ok: true }
  }
  if (truncated) {
    return {
      ok: false,
      failureCategory: 'truncated',
      message: `version-pinned document ${policy.provenance.arxiv_id} requires complete PDF admission (wire/decompressed limits ${policy.wire_byte_limit}/${policy.decompressed_byte_limit})`,
    }
  }
  const digest = sha256Hex(admittedBytes)
  if (digest !== policy.expected_content_sha256) {
    return {
      ok: false,
      failureCategory: 'policy_denied',
      message: `version-pinned document digest mismatch for ${policy.provenance.arxiv_id}`,
    }
  }
  if (admittedBytes.length !== policy.expected_byte_length) {
    return {
      ok: false,
      failureCategory: 'policy_denied',
      message: `version-pinned document byte length mismatch for ${policy.provenance.arxiv_id}`,
    }
  }
  return { ok: true }
}
