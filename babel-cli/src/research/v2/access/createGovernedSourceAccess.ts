import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { AdmittedSearchIndexEntry } from './admittedMissionSourceSearch.js'
import type { BabelWebSearchTransport } from './babelConfiguredWebSearch.js'
import {
  createAdmittedSourceSearchProvider,
  type ResearchSourceSearchMode,
} from './createAdmittedSourceSearchProvider.js'
import { createGovernedSourceAccessPort, type GovernedSourceAccessPortOptions } from './governedSourceAccessPort.js'
import type { FetchSourceAccessPortOptions } from './fetchSourceAccessPort.js'

export interface CreateGovernedSourceAccessOptions extends FetchSourceAccessPortOptions {
  mission: ResearchMissionV2
  searchMode: ResearchSourceSearchMode
  corpusIndex?: readonly AdmittedSearchIndexEntry[]
  webSearchTransport?: BabelWebSearchTransport
  env?: NodeJS.ProcessEnv
}

export function createGovernedSourceAccessForMission(options: CreateGovernedSourceAccessOptions) {
  const resolved = createAdmittedSourceSearchProvider({
    mode: options.searchMode,
    mission: options.mission,
    ...(options.corpusIndex ? { corpusIndex: options.corpusIndex } : {}),
    ...(options.webSearchTransport ? { webSearchTransport: options.webSearchTransport } : {}),
    ...(options.env ? { env: options.env } : {}),
  })
  const port = createGovernedSourceAccessPort({
    mission: options.mission,
    searchProvider: resolved.provider,
    ...(options.admittedGet ? { admittedGet: options.admittedGet } : {}),
    ...(options.maxAdmittedBytes !== undefined ? { maxAdmittedBytes: options.maxAdmittedBytes } : {}),
  })
  return { port, search: resolved }
}
