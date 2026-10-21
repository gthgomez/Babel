import type { ResearchMissionV2 } from '../contracts/mission.js'
import type {
  SourceAccessPort,
  SourceFetchRequest,
  SourceFetchResult,
  SourceSearchRequest,
  SourceSearchResult,
} from '../ports/sourceAccessPort.js'
import {
  admittedMissionSourceSearch,
  type AdmittedSearchIndexEntry,
} from './admittedMissionSourceSearch.js'
import { FetchSourceAccessPort, type FetchSourceAccessPortOptions } from './fetchSourceAccessPort.js'

export interface MissionScopedSourceAccessPortOptions extends FetchSourceAccessPortOptions {
  mission: ResearchMissionV2
  searchIndex: readonly AdmittedSearchIndexEntry[]
}

/**
 * Governed fetch (GET) plus mission-admitted search over a declared index.
 * Production live indexes may be supplied by registry/bootstrap; tests inject offline corpora.
 */
export class MissionScopedSourceAccessPort implements SourceAccessPort {
  private readonly fetchPort: FetchSourceAccessPort

  constructor(private readonly options: MissionScopedSourceAccessPortOptions) {
    this.fetchPort = new FetchSourceAccessPort(options)
  }

  search(request: SourceSearchRequest): Promise<SourceSearchResult> {
    return Promise.resolve(
      admittedMissionSourceSearch(request, this.options.mission, this.options.searchIndex),
    )
  }

  fetchContent(request: SourceFetchRequest): Promise<SourceFetchResult> {
    return this.fetchPort.fetchContent(request)
  }
}

export function createMissionScopedSourceAccessPort(
  options: MissionScopedSourceAccessPortOptions,
): MissionScopedSourceAccessPort {
  return new MissionScopedSourceAccessPort(options)
}
