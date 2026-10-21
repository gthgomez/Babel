import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import { parseAdmittedHttpUrl } from './admittedHttpGet.js'

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
  if (source.kind === 'repository_file' && mission.pinned_target_repository) {
    const repoId = source.canonical_identifiers?.github_repo_id
    if (repoId && repoId !== mission.pinned_target_repository.repo_id) {
      return false
    }
    const sha = source.canonical_identifiers?.github_commit_sha
    if (sha && sha !== mission.pinned_target_repository.commit_sha) {
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
