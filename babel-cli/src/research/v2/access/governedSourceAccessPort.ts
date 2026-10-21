import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { AdmittedSourceSearchProvider } from '../ports/admittedSourceSearchProvider.js'
import type {
  SourceAccessPort,
  SourceFetchRequest,
  SourceFetchResult,
  SourceSearchRequest,
  SourceSearchResult,
} from '../ports/sourceAccessPort.js'
import { FetchSourceAccessPort, type FetchSourceAccessPortOptions } from './fetchSourceAccessPort.js'

export interface GovernedSourceAccessPortOptions extends FetchSourceAccessPortOptions {
  mission: ResearchMissionV2
  searchProvider: AdmittedSourceSearchProvider
}

/**
 * Production-shaped {@link SourceAccessPort}: governed GET fetch + injected admitted search provider.
 */
export class GovernedSourceAccessPort implements SourceAccessPort {
  private readonly fetchPort: FetchSourceAccessPort

  constructor(private readonly options: GovernedSourceAccessPortOptions) {
    this.fetchPort = new FetchSourceAccessPort({ ...options, mission: options.mission })
  }

  search(request: SourceSearchRequest): Promise<SourceSearchResult> {
    return this.options.searchProvider.search(request, this.options.mission)
  }

  fetchContent(request: SourceFetchRequest): Promise<SourceFetchResult> {
    return this.fetchPort.fetchContent(request)
  }
}

export function createGovernedSourceAccessPort(
  options: GovernedSourceAccessPortOptions,
): GovernedSourceAccessPort {
  return new GovernedSourceAccessPort(options)
}
