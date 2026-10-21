import type { SourceAdapter, SourceAdapterRegistry } from '../ports/sourceAdapter.js'
import type {
  ResearchProfileDefinition,
  ResearchProfileRegistry,
} from '../ports/researchProfileDefinition.js'
import { TechnicalRepositoryFileAdapter } from '../profiles/technical/repositoryFileAdapter.js'
import { technicalProfileDefinition } from '../profiles/technical/technicalProfileDefinition.js'

class MapSourceAdapterRegistry implements SourceAdapterRegistry {
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
