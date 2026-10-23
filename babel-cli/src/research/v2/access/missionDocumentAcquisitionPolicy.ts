import { createHash } from 'node:crypto'
import type { MissionAdmittedDocumentSource, ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import { parseAdmittedHttpUrl } from './admittedHttpGet.js'
import { hostnameAllowed } from './missionDocumentAdmission.js'

export interface DocumentFetchByteBudgets {
  maxWireBytes: number
  maxDecodedBytes: number
}

export function normalizeDocumentUrl(url: string): string {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

/**
 * Policy applies only to the exact fetch URL when it is mission-selected and declared
 * in admitted_document_sources. Other observed_urls cannot borrow this budget.
 */
export function resolveMissionDocumentPolicyForFetchUrl(
  source: SourceRecord,
  mission: ResearchMissionV2 | undefined,
  fetchUrl: string,
): MissionAdmittedDocumentSource | undefined {
  if (!mission) return undefined
  if (source.kind !== 'document' && source.kind !== 'paper') return undefined
  const normalizedFetch = normalizeDocumentUrl(fetchUrl)
  const selected = mission.source_policy.selected_document_refs ?? []
  if (!selected.some((ref) => normalizeDocumentUrl(ref) === normalizedFetch)) {
    return undefined
  }
  for (const entry of mission.source_policy.admitted_document_sources ?? []) {
    if (normalizeDocumentUrl(entry.document_ref) === normalizedFetch) {
      return entry
    }
  }
  return undefined
}

export function intersectDocumentFetchByteBudgets(
  policy: MissionAdmittedDocumentSource | undefined,
  hostWireCeiling: number,
  hostDecodedCeiling: number,
): DocumentFetchByteBudgets {
  if (!policy) {
    return { maxWireBytes: hostWireCeiling, maxDecodedBytes: hostDecodedCeiling }
  }
  return {
    maxWireBytes: Math.min(hostWireCeiling, policy.wire_byte_budget),
    maxDecodedBytes: Math.min(hostDecodedCeiling, policy.decompressed_byte_budget),
  }
}

/** Pre-dispatch: policy-bound document fetch URL must match declared document_ref. */
export function assertDocumentPolicyFetchUrl(
  fetchUrl: string,
  policy: MissionAdmittedDocumentSource,
): string | null {
  if (normalizeDocumentUrl(fetchUrl) !== normalizeDocumentUrl(policy.document_ref)) {
    return 'document fetch URL does not match admitted document_ref'
  }
  return null
}

/** Each redirect hop must stay on mission-allowed domains; final URL must match document_ref. */
export function assertDocumentPolicyRedirectHop(
  hopUrl: string,
  policy: MissionAdmittedDocumentSource,
  mission: ResearchMissionV2,
): string | null {
  try {
    const parsed = parseAdmittedHttpUrl(hopUrl)
    if (!hostnameAllowed(parsed.hostname, mission)) {
      return `document redirect hop ${hopUrl} is outside mission allowed_web_domains`
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return `document redirect hop ${hopUrl} failed admission: ${message}`
  }
  return null
}

export function assertDocumentPolicyFinalUrl(
  finalUrl: string,
  policy: MissionAdmittedDocumentSource,
): string | null {
  if (normalizeDocumentUrl(finalUrl) !== normalizeDocumentUrl(policy.document_ref)) {
    return 'document fetch final URL does not match admitted document_ref'
  }
  return null
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export type MissionDocumentAdmissionVerdict =
  | { ok: true }
  | {
      ok: false
      failureCategory: 'truncated' | 'policy_denied'
      message: string
    }

export function verifyMissionAdmittedDocumentBody(
  policy: MissionAdmittedDocumentSource,
  admittedBytes: Buffer,
  truncated: boolean,
): MissionDocumentAdmissionVerdict {
  if (policy.require_complete_body && truncated) {
    return {
      ok: false,
      failureCategory: 'truncated',
      message: `admitted document requires complete body (wire/decompressed budgets ${policy.wire_byte_budget}/${policy.decompressed_byte_budget})`,
    }
  }
  const digest = sha256Hex(admittedBytes)
  if (digest !== policy.expected_content_sha256.toLowerCase()) {
    return {
      ok: false,
      failureCategory: 'policy_denied',
      message: 'admitted document content digest does not match mission-declared digest',
    }
  }
  if (admittedBytes.length !== policy.expected_byte_length) {
    return {
      ok: false,
      failureCategory: 'policy_denied',
      message: 'admitted document byte length does not match mission-declared length',
    }
  }
  return { ok: true }
}
