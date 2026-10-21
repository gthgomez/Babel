import type { SourceAdapter } from '../ports/sourceAdapter.js'
import type { ResearchProfileDefinition } from '../ports/researchProfileDefinition.js'
import { generalAdapterCatalog } from '../profiles/general/generalAdapterCatalog.js'
import {
  GENERAL_PROFILE_ID,
  GENERAL_PROFILE_VERSION,
  generalProfileDefinition,
} from '../profiles/general/generalProfileDefinition.js'
import {
  createTechnicalResearchRegistries,
  withAdditionalProfiles,
  withAdditionalSourceAdapters,
} from './frozenRegistries.js'

/**
 * Agent B ownership: profiles/general, adapters/web, adapters/documents.
 * Registry wiring is Agent A; adapters come from {@link generalAdapterCatalog} (B80a7a9ef).
 */
export interface CombinedResearchRegistries extends ReturnType<typeof createTechnicalResearchRegistries> {
  bAdaptersRegistered: string[]
}

function asResearchProfileDefinition(): ResearchProfileDefinition {
  return {
    profileId: GENERAL_PROFILE_ID,
    profileVersion: GENERAL_PROFILE_VERSION,
    preferredSourceClasses: [...generalProfileDefinition.preferredSourceClasses],
    questionTemplates: [...generalProfileDefinition.questionTemplates],
    reportSections: [...generalProfileDefinition.reportSections],
  }
}

/** Technical baseline plus B-reviewed general document/web adapters from catalog factories. */
export async function createCombinedResearchRegistries(): Promise<CombinedResearchRegistries> {
  const technical = createTechnicalResearchRegistries()
  const reviewedAdapters: SourceAdapter[] = [
    generalAdapterCatalog.document.factory(),
    generalAdapterCatalog.web.factory(),
  ]
  const registered = [
    `documents/${generalAdapterCatalog.document.adapterId}`,
    `web/${generalAdapterCatalog.web.adapterId}`,
  ]

  let registries = withAdditionalProfiles(technical, [asResearchProfileDefinition()])
  registries = withAdditionalSourceAdapters(registries, reviewedAdapters)

  return {
    ...registries,
    bAdaptersRegistered: registered,
  }
}
