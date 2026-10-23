import type { AdmittedContent } from '../../contracts/admittedContent.js'
import type { SourceRecord } from '../../contracts/sources.js'

const GITHUB_BLOB_PATH =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([a-f0-9]{40})\/(.+)$/i

const GITHUB_RAW_PATH =
  /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([a-f0-9]{40})\/(.+)$/i

export interface PinnedGithubBlobRef {
  owner: string
  repo: string
  commitSha: string
  path: string
}

export function parseGithubCanonicalKey(
  canonicalKey: string,
): { owner: string; repo: string; path: string } | null {
  const match = /^github:([^:]+)\/([^:]+):(.+)$/.exec(canonicalKey)
  if (!match?.[1] || !match[2] || !match[3]) return null
  return { owner: match[1], repo: match[2], path: match[3] }
}

export function parsePinnedGithubBlobUrl(url: string): PinnedGithubBlobRef | null {
  const blob = GITHUB_BLOB_PATH.exec(url)
  if (!blob?.[1] || !blob[2] || !blob[3] || !blob[4]) return null
  return {
    owner: blob[1],
    repo: blob[2],
    commitSha: blob[3],
    path: blob[4],
  }
}

export function parsePinnedGithubRawContentUrl(url: string): PinnedGithubBlobRef | null {
  const raw = GITHUB_RAW_PATH.exec(url)
  if (!raw?.[1] || !raw[2] || !raw[3] || !raw[4]) return null
  return {
    owner: raw[1],
    repo: raw[2],
    commitSha: raw[3],
    path: raw[4],
  }
}

export function pinnedGithubBlobUrlToRawContentUrl(blobUrl: string): string | null {
  const parsed = parsePinnedGithubBlobUrl(blobUrl)
  if (!parsed) return null
  return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.commitSha}/${parsed.path}`
}

export function pinnedGithubRefToBlobUrl(ref: PinnedGithubBlobRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/blob/${ref.commitSha}/${ref.path}`
}

function pinnedRefFromTransportHop(hopUrl: string): PinnedGithubBlobRef | null {
  return parsePinnedGithubBlobUrl(hopUrl) ?? parsePinnedGithubRawContentUrl(hopUrl)
}

/** Reject hops that do not identify the same pinned blob/ref; never rewrite transport URLs. */
export function assertRepositoryFileTransportHopMatchesPin(
  hopUrl: string,
  expected: PinnedGithubBlobRef,
): void {
  const ref = pinnedRefFromTransportHop(hopUrl)
  if (!ref) {
    throw new TechnicalRepositoryPinError(
      `repository_file fetch hop is not a pinned github blob or raw URL: ${hopUrl}`,
    )
  }
  assertBlobRefMatchesExpected('fetch hop', ref, expected)
}

/** Explicit equivalence: pinned blob URL must map to the immutable raw URL used for fetch. */
export function assertImmutableRawUrlForPinnedBlob(observedBlobUrl: string, fetchUrl: string): void {
  const expectedRaw = pinnedGithubBlobUrlToRawContentUrl(observedBlobUrl)
  if (!expectedRaw) {
    throw new TechnicalRepositoryPinError('observed URL is not a pinned github blob URL')
  }
  if (fetchUrl !== expectedRaw) {
    throw new TechnicalRepositoryPinError(
      'repository_file fetch URL must equal immutable raw.githubusercontent.com URL for pinned blob',
    )
  }
}

function expectedBlobRef(source: SourceRecord): PinnedGithubBlobRef {
  const commitSha = source.canonical_identifiers?.github_commit_sha
  if (!commitSha || !/^[a-f0-9]{40}$/i.test(commitSha)) {
    throw new TechnicalRepositoryPinError('repository_file requires canonical_identifiers.github_commit_sha')
  }
  const parsed = parseGithubCanonicalKey(source.canonical_key)
  if (!parsed) {
    throw new TechnicalRepositoryPinError('repository_file canonical_key must be github:owner/repo:path')
  }
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    commitSha,
    path: parsed.path,
  }
}

function assertBlobRefMatchesExpected(
  label: string,
  actual: PinnedGithubBlobRef,
  expected: PinnedGithubBlobRef,
): void {
  if (actual.commitSha.toLowerCase() !== expected.commitSha.toLowerCase()) {
    throw new TechnicalRepositoryPinError(`${label} commit does not match github_commit_sha`)
  }
  if (actual.owner.toLowerCase() !== expected.owner.toLowerCase()) {
    throw new TechnicalRepositoryPinError(`${label} owner does not match canonical repository`)
  }
  if (actual.repo.toLowerCase() !== expected.repo.toLowerCase()) {
    throw new TechnicalRepositoryPinError(`${label} repository does not match canonical repository`)
  }
  if (actual.path !== expected.path) {
    throw new TechnicalRepositoryPinError(`${label} path does not match canonical_key`)
  }
}

export function assertRepositoryFilePinning(source: SourceRecord): void {
  const expected = expectedBlobRef(source)
  for (const url of source.observed_urls) {
    if (/\/blob\/main\//i.test(url)) {
      throw new TechnicalRepositoryPinError('observed_urls must not use floating /blob/main/ ref')
    }
    const blob = parsePinnedGithubBlobUrl(url)
    if (!blob) {
      throw new TechnicalRepositoryPinError('observed_urls must be commit-pinned github blob URLs')
    }
    assertBlobRefMatchesExpected('observed_url', blob, expected)
  }
}

export function assertAdmissionBindsToPinnedSource(
  source: SourceRecord,
  fetchOperationId: string,
  admitted: AdmittedContent,
  responseOperationId: string,
): void {
  assertRepositoryFilePinning(source)
  const expected = expectedBlobRef(source)

  if (responseOperationId !== fetchOperationId) {
    throw new TechnicalRepositoryPinError('fetch response operation_id does not match request')
  }
  if (admitted.operation_id !== fetchOperationId) {
    throw new TechnicalRepositoryPinError('admitted operation_id does not match fetch operation')
  }
  if (admitted.revision.source_id !== source.source_id) {
    throw new TechnicalRepositoryPinError('admitted revision source_id mismatch')
  }

  const pin = admitted.provenance.repository_file_pin
  if (!pin?.pinned_blob_url) {
    throw new TechnicalRepositoryPinError(
      'repository_file admitted provenance requires repository_file_pin.pinned_blob_url',
    )
  }
  if (!source.observed_urls.includes(pin.pinned_blob_url)) {
    throw new TechnicalRepositoryPinError(
      'repository_file_pin.pinned_blob_url must appear on source observed_urls',
    )
  }
  const pinnedObserved = parsePinnedGithubBlobUrl(pin.pinned_blob_url)
  if (!pinnedObserved) {
    throw new TechnicalRepositoryPinError('repository_file_pin.pinned_blob_url is not a pinned github blob URL')
  }
  assertBlobRefMatchesExpected('repository_file_pin.pinned_blob_url', pinnedObserved, expected)

  const { requested_url, final_url, redirect_chain } = admitted.provenance
  if (redirect_chain.length < 1) {
    throw new TechnicalRepositoryPinError('admitted redirect_chain must contain at least the requested URL')
  }
  if (redirect_chain[0] !== requested_url) {
    throw new TechnicalRepositoryPinError('admitted redirect_chain must start with requested_url')
  }
  if (redirect_chain[redirect_chain.length - 1] !== final_url) {
    throw new TechnicalRepositoryPinError('admitted redirect_chain must end with final_url')
  }
  for (const hop of redirect_chain) {
    assertRepositoryFileTransportHopMatchesPin(hop, expected)
  }
}

export class TechnicalRepositoryPinError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TechnicalRepositoryPinError'
  }
}
