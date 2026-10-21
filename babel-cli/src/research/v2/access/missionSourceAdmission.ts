import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import {
  parsePinnedGithubBlobUrl,
  parsePinnedGithubRawContentUrl,
} from '../profiles/technical/repositoryFilePinning.js'
import { parseAdmittedHttpUrl } from './admittedHttpGet.js'
import { missionPinnedRepositories } from './missionPinnedRepositories.js'

function hostnameAllowed(hostname: string, mission: ResearchMissionV2): boolean {
  const allowed = mission.source_policy.allowed_web_domains
  if (!allowed || allowed.length === 0) return false
  const host = hostname.toLowerCase()
  return allowed.some((domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`))
}

/** Mission admission for a source record (search index filtering and pre-fetch gate). */
export function sourceAdmittedForMission(source: SourceRecord, mission: ResearchMissionV2): boolean {
  if (!mission.source_policy.allowed_source_classes.includes(source.kind)) {
    return false
  }
  if (source.kind === 'repository_file') {
    const pins = missionPinnedRepositories(mission)
    if (pins.length === 0) {
      return true
    }
    const repoId = source.canonical_identifiers?.github_repo_id
    const sha = source.canonical_identifiers?.github_commit_sha
    if (!repoId || !sha) {
      return false
    }
    const admitted = pins.some(
      (pin) =>
        pin.repo_id === repoId && pin.commit_sha.toLowerCase() === sha.toLowerCase(),
    )
    if (!admitted) {
      return false
    }
  }
  if (source.kind === 'web') {
    const url = source.observed_urls[0]
    if (!url) return false
    try {
      const parsed = parseAdmittedHttpUrl(url)
      if (!hostnameAllowed(parsed.hostname, mission)) return false
    } catch {
      return false
    }
  }
  return true
}

export interface MissionFetchAdmissionFailure {
  failureCategory: 'policy_denied' | 'pin_binding_failed'
  message: string
}

export function validateMissionFetchAdmission(
  source: SourceRecord,
  mission: ResearchMissionV2,
): MissionFetchAdmissionFailure | null {
  if (!sourceAdmittedForMission(source, mission)) {
    return {
      failureCategory: 'policy_denied',
      message: `source ${source.source_id} is not admitted for mission source policy`,
    }
  }
  return null
}

/** Single HTTP hop URL admission for web sources (pre-dispatch). */
function repositoryFileHopMatchesPin(hopUrl: string, source: SourceRecord): string | null {
  const blob = source.observed_urls.map((u) => parsePinnedGithubBlobUrl(u)).find(Boolean)
  if (!blob) {
    return 'repository_file source has no commit-pinned github blob observed_url'
  }
  const hopBlob = parsePinnedGithubBlobUrl(hopUrl) ?? parsePinnedGithubRawContentUrl(hopUrl)
  if (!hopBlob) {
    return `repository_file fetch hop must be pinned github blob or raw content URL`
  }
  if (hopBlob.owner.toLowerCase() !== blob.owner.toLowerCase()) {
    return 'repository_file fetch hop owner does not match pinned source'
  }
  if (hopBlob.repo.toLowerCase() !== blob.repo.toLowerCase()) {
    return 'repository_file fetch hop repository does not match pinned source'
  }
  if (hopBlob.commitSha.toLowerCase() !== blob.commitSha.toLowerCase()) {
    return 'repository_file fetch hop commit does not match pinned source'
  }
  if (hopBlob.path !== blob.path) {
    return 'repository_file fetch hop path does not match pinned source'
  }
  return null
}

export function validateMissionWebHopUrl(
  hopUrl: string,
  source: SourceRecord,
  mission: ResearchMissionV2,
): string | null {
  if (source.kind === 'repository_file') {
    return repositoryFileHopMatchesPin(hopUrl, source)
  }
  if (source.kind !== 'web') {
    return null
  }
  try {
    const parsed = parseAdmittedHttpUrl(hopUrl)
    if (!hostnameAllowed(parsed.hostname, mission)) {
      return `hop ${hopUrl} is outside mission allowed_web_domains`
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return `hop ${hopUrl} failed admission: ${message}`
  }
  return null
}

/** Each redirect hop must remain admitted for web sources (domain policy). */
export function validateRedirectChainForMission(
  redirectChain: readonly string[],
  source: SourceRecord,
  mission: ResearchMissionV2,
): string | null {
  if (source.kind !== 'web') {
    return null
  }
  for (const hop of redirectChain) {
    try {
      const parsed = parseAdmittedHttpUrl(hop)
      if (!hostnameAllowed(parsed.hostname, mission)) {
        return `redirect hop ${hop} is outside mission allowed_web_domains`
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return `redirect hop ${hop} failed admission: ${message}`
    }
  }
  return null
}
