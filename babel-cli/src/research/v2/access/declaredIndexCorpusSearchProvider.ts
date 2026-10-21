import type { AdmittedSourceSearchProvider } from '../ports/admittedSourceSearchProvider.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceSearchRequest, SourceSearchResult } from '../ports/sourceAccessPort.js'
import {
  admittedMissionSourceSearch,
  type AdmittedSearchIndexEntry,
} from './admittedMissionSourceSearch.js'

/**
 * **Declared-index corpus search** — queries a host-supplied manifest/index only.
 * This is not open-web discovery; production open-web search uses a separate
 * {@link AdmittedSourceSearchProvider} implementation (B-owned web adapter/catalog).
 */
export function createDeclaredIndexCorpusSearchProvider(
  index: readonly AdmittedSearchIndexEntry[],
): AdmittedSourceSearchProvider {
  return {
    search(request: SourceSearchRequest, mission: ResearchMissionV2): Promise<SourceSearchResult> {
      return Promise.resolve(admittedMissionSourceSearch(request, mission, index))
    },
  }
}
