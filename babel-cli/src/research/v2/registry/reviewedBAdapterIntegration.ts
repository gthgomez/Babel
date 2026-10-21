import {
  GENERAL_DOCUMENT_ADAPTER_ID,
  GeneralDocumentAdapter,
} from '../adapters/documents/generalDocumentAdapter.js'
import type { SourceAdapter } from '../ports/sourceAdapter.js'
import type { ResearchProfileDefinition } from '../ports/researchProfileDefinition.js'
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
import { loadRepairInProgressBWebCatalog } from './loadRepairInProgressBWebCatalog.js'

/**
 * Agent B ownership: profiles/general (except registry wiring), adapters/web, adapters/documents.
 * Reviewed export @ 196098d9: {@link GeneralDocumentAdapter} + {@link generalProfileDefinition}.
 * HTML/PDF catalog slice loads only when B modules exist; ids land in `bAdaptersRepairInProgress`.
 */
export interface CombinedResearchRegistries extends ReturnType<typeof createTechnicalResearchRegistries> {
  /** Independently reviewed B adapter registration keys (Agent A registry wiring). */
  bAdaptersRegistered: string[]
  /** B HTML/PDF slice present locally but not accepted for review yet. */
  bAdaptersRepairInProgress: string[]
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

/** Technical baseline plus B-reviewed document adapter and optional in-repair web/catalog slice. */
export async function createCombinedResearchRegistries(): Promise<CombinedResearchRegistries> {
  const technical = createTechnicalResearchRegistries()
  const reviewedAdapters: SourceAdapter[] = [new GeneralDocumentAdapter()]
  const registered = [`documents/${GENERAL_DOCUMENT_ADAPTER_ID}`]

  let registries = withAdditionalProfiles(technical, [asResearchProfileDefinition()])
  registries = withAdditionalSourceAdapters(registries, reviewedAdapters)

  const repairSlice = await loadRepairInProgressBWebCatalog()
  if (repairSlice.adapters.length > 0) {
    registries = withAdditionalSourceAdapters(registries, repairSlice.adapters)
  }

  return {
    ...registries,
    bAdaptersRegistered: registered,
    bAdaptersRepairInProgress: repairSlice.adapterIds,
  }
}
