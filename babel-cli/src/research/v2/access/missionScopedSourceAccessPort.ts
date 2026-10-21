import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceAccessPort } from '../ports/sourceAccessPort.js'
import type { AdmittedSearchIndexEntry } from './admittedMissionSourceSearch.js'
import { createDeclaredIndexCorpusSearchProvider } from './declaredIndexCorpusSearchProvider.js'
import {
  createGovernedSourceAccessPort,
  type GovernedSourceAccessPortOptions,
} from './governedSourceAccessPort.js'
import type { FetchSourceAccessPortOptions } from './fetchSourceAccessPort.js'

export interface MissionScopedSourceAccessPortOptions extends FetchSourceAccessPortOptions {
  mission: ResearchMissionV2
  /** Declared-index corpus entries — corpus search only, not open-web discovery. */
  searchIndex: readonly AdmittedSearchIndexEntry[]
}

/** @deprecated Prefer {@link createGovernedSourceAccessPort} with an explicit search provider. */
export function createMissionScopedSourceAccessPort(
  options: MissionScopedSourceAccessPortOptions,
): SourceAccessPort {
  const governed: GovernedSourceAccessPortOptions = {
    ...options,
    searchProvider: createDeclaredIndexCorpusSearchProvider(options.searchIndex),
  }
  return createGovernedSourceAccessPort(governed)
}
