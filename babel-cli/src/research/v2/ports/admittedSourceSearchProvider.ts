import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceSearchRequest, SourceSearchResult } from './sourceAccessPort.js'

/**
 * Pluggable admitted search behind {@link SourceAccessPort#search}.
 * Open-web discovery and HTML/PDF extraction are B-owned; providers register at integration time.
 */
export interface AdmittedSourceSearchProvider {
  search(request: SourceSearchRequest, mission: ResearchMissionV2): Promise<SourceSearchResult>
}
