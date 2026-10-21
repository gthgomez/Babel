import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import { GENERAL_DOCUMENT_ADAPTER_ID } from '../adapters/documents/generalDocumentAdapter.js'
import { GENERAL_WEB_ADAPTER_ID } from '../adapters/web/generalWebAdapter.js'
import type { SourceAdapter, SourceAdapterRegistry } from '../ports/sourceAdapter.js'
import type { ResearchProfileRegistry } from '../ports/researchProfileDefinition.js'
import { TECHNICAL_REPOSITORY_FILE_ADAPTER_ID } from '../profiles/technical/repositoryFileAdapter.js'
import { isPdfMediaType } from '../adapters/documents/pdfAdmission.js'

const DISCOVERY_CAPABLE_ADAPTER_IDS = new Set<string>([
  GENERAL_WEB_ADAPTER_ID,
  TECHNICAL_REPOSITORY_FILE_ADAPTER_ID,
])

export function adapterSupportsDiscovery(adapter: SourceAdapter): boolean {
  return DISCOVERY_CAPABLE_ADAPTER_IDS.has(adapter.adapterId)
}

export interface MissionRegistryBundle {
  sourceAdapters: SourceAdapterRegistry
  profiles: ResearchProfileRegistry
}

/**
 * Discovery adapter: first preferred source class with a search-backed adapter (web before document).
 */
export function resolveDiscoveryAdapterForMission(
  mission: ResearchMissionV2,
  registries: MissionRegistryBundle,
): SourceAdapter | undefined {
  const profile = registries.profiles.get(mission.profile_id, mission.profile_version)
  if (!profile) return undefined
  const adapters = registries.sourceAdapters.listAdapters()
  for (const sourceClass of profile.preferredSourceClasses) {
    const discoveryMatches = adapters.filter(
      (adapter) => adapter.supportedKinds.includes(sourceClass) && adapterSupportsDiscovery(adapter),
    )
    if (discoveryMatches.length > 0) {
      const webFirst = discoveryMatches.find((a) => a.adapterId === GENERAL_WEB_ADAPTER_ID)
      return webFirst ?? discoveryMatches[0]
    }
  }
  return undefined
}

/** Read adapter for an admitted source (and optional media type after fetch admission). */
export function resolveReadAdapterForSource(
  source: SourceRecord,
  registries: MissionRegistryBundle,
  options?: { mediaType?: string },
): SourceAdapter | undefined {
  const adapters = registries.sourceAdapters.listAdapters()
  const byId = (id: string) => adapters.find((a) => a.adapterId === id)

  if (source.kind === 'repository_file') {
    return byId(TECHNICAL_REPOSITORY_FILE_ADAPTER_ID)
  }
  if (source.kind === 'web') {
    return byId(GENERAL_WEB_ADAPTER_ID)
  }
  if (source.kind === 'document') {
    return byId(GENERAL_DOCUMENT_ADAPTER_ID)
  }
  const mediaType = options?.mediaType?.toLowerCase() ?? ''
  if (mediaType.includes('html')) {
    return byId(GENERAL_WEB_ADAPTER_ID)
  }
  if (mediaType.includes('pdf') || isPdfMediaType(mediaType)) {
    return byId(GENERAL_DOCUMENT_ADAPTER_ID)
  }
  return undefined
}

/** @deprecated Prefer {@link resolveDiscoveryAdapterForMission} + {@link resolveReadAdapterForSource}. */
export function resolveSourceAdapterForMission(
  mission: ResearchMissionV2,
  registries: MissionRegistryBundle,
): SourceAdapter | undefined {
  return resolveDiscoveryAdapterForMission(mission, registries)
}
