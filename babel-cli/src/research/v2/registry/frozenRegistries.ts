import type { SourceAdapter, SourceAdapterRegistry } from '../ports/sourceAdapter.js'
import type {
  ResearchProfileDefinition,
  ResearchProfileRegistry,
} from '../ports/researchProfileDefinition.js'
import { TechnicalRepositoryFileAdapter } from '../profiles/technical/repositoryFileAdapter.js'
import { technicalProfileDefinition } from '../profiles/technical/technicalProfileDefinition.js'

export class MapSourceAdapterRegistry implements SourceAdapterRegistry {
  constructor(private readonly byId: ReadonlyMap<string, SourceAdapter>) {}

  getAdapter(adapterId: string): SourceAdapter | undefined {
    return this.byId.get(adapterId)
  }

  listAdapters(): readonly SourceAdapter[] {
    return [...this.byId.values()]
  }
}

class MapProfileRegistry implements ResearchProfileRegistry {
  constructor(private readonly profiles: readonly ResearchProfileDefinition[]) {}

  get(profileId: string, profileVersion?: string): ResearchProfileDefinition | undefined {
    return this.profiles.find((p) => {
      if (p.profileId !== profileId) return false
      if (profileVersion !== undefined && p.profileVersion !== profileVersion) return false
      return true
    })
  }
}

/** Checkpoint-frozen technical bundle: one repository-file adapter + technical profile definition. */
export function createTechnicalResearchRegistries(): {
  sourceAdapters: SourceAdapterRegistry
  profiles: ResearchProfileRegistry
} {
  const repositoryFile = new TechnicalRepositoryFileAdapter()
  const sourceAdapters = new MapSourceAdapterRegistry(
    new Map([[repositoryFile.adapterId, repositoryFile]]),
  )
  const profiles = new MapProfileRegistry([technicalProfileDefinition])
  return { sourceAdapters, profiles }
}

export {
  adapterSupportsDiscovery,
  resolveDiscoveryAdapterForMission,
  resolveReadAdapterForSource,
  resolveSourceAdapterForMission,
} from './missionAdapterResolution.js'

export function withAdditionalSourceAdapters(
  registries: ReturnType<typeof createTechnicalResearchRegistries>,
  adapters: readonly SourceAdapter[],
): ReturnType<typeof createTechnicalResearchRegistries> {
  const byId = new Map(registries.sourceAdapters.listAdapters().map((a) => [a.adapterId, a]))
  for (const adapter of adapters) {
    byId.set(adapter.adapterId, adapter)
  }
  return {
    sourceAdapters: new MapSourceAdapterRegistry(byId),
    profiles: registries.profiles,
  }
}

export function withAdditionalProfiles(
  registries: ReturnType<typeof createTechnicalResearchRegistries>,
  additional: readonly ResearchProfileDefinition[],
): ReturnType<typeof createTechnicalResearchRegistries> {
  const profiles: ResearchProfileDefinition[] = [technicalProfileDefinition]
  for (const profile of additional) {
    if (
      profile.profileId === technicalProfileDefinition.profileId &&
      profile.profileVersion === technicalProfileDefinition.profileVersion
    ) {
      continue
    }
    profiles.push(profile)
  }
  return {
    sourceAdapters: registries.sourceAdapters,
    profiles: new MapProfileRegistry(profiles),
  }
}
