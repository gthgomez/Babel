import { createHash } from 'node:crypto'
import type { ResearchMissionV2 } from '../contracts/mission.js'

type PinnedRepositoryRef = NonNullable<ResearchMissionV2['pinned_target_repository']>
import type { SourceRecord } from '../contracts/sources.js'

/** Declared repository pins: primary target plus optional additional selected refs. */
export function missionPinnedRepositories(mission: ResearchMissionV2): PinnedRepositoryRef[] {
  const seen = new Set<string>()
  const pins: PinnedRepositoryRef[] = []
  const push = (ref: PinnedRepositoryRef) => {
    const key = `${ref.repo_id}@${ref.commit_sha.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    pins.push(ref)
  }
  if (mission.pinned_target_repository) {
    push(mission.pinned_target_repository)
  }
  for (const ref of mission.source_policy.selected_repository_refs ?? []) {
    push(ref)
  }
  return pins
}

export function repositoryFileSourceFromPinnedPath(
  pin: PinnedRepositoryRef,
  path: string,
): SourceRecord | null {
  const match = /^github:([^/]+)\/([^/]+)$/i.exec(pin.repo_id.trim())
  if (!match?.[1] || !match[2]) return null
  const owner = match[1]
  const repo = match[2]
  const canonicalKey = `github:${owner}/${repo}:${path}`
  const blobUrl = `https://github.com/${pin.full_name}/blob/${pin.commit_sha}/${path}`
  return {
    source_id: `src-repo-${createHash('sha256').update(canonicalKey).digest('hex').slice(0, 24)}`,
    kind: 'repository_file',
    canonical_key: canonicalKey,
    canonical_identifiers: {
      github_repo_id: pin.repo_id,
      github_commit_sha: pin.commit_sha,
    },
    observed_urls: [blobUrl],
    title: path,
  }
}

export function missionScopedToRepositoryPin(
  mission: ResearchMissionV2,
  pin: PinnedRepositoryRef,
): ResearchMissionV2 {
  return {
    ...mission,
    pinned_target_repository: pin,
    source_policy: {
      ...mission.source_policy,
      selected_repository_refs: undefined,
    },
  }
}

/** Restrict document discovery to one mission-declared ref for composed retrieval slots. */
export function missionScopedToDocumentRef(
  mission: ResearchMissionV2,
  documentRef: string,
): ResearchMissionV2 {
  return {
    ...mission,
    source_policy: {
      ...mission.source_policy,
      selected_document_refs: [documentRef],
    },
  }
}
