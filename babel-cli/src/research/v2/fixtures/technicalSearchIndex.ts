import type { AdmittedSearchIndexEntry } from '../access/admittedMissionSourceSearch.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import {
  technicalRepositoryCorpusBody,
  technicalRepositoryCorpusSource,
} from './technicalRepositoryCorpus.js'

/** Offline admitted search index for the pinned technical repository fixture mission. */
export function technicalRepositorySearchIndex(): AdmittedSearchIndexEntry[] {
  return [
    {
      source: technicalRepositoryCorpusSource,
      searchableText: `${technicalRepositoryCorpusSource.canonical_key} ${technicalRepositoryCorpusBody}`,
    },
  ]
}

export function searchIndexForTechnicalMission(_mission: ResearchMissionV2): AdmittedSearchIndexEntry[] {
  return technicalRepositorySearchIndex()
}
