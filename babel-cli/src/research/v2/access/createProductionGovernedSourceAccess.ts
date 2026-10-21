import type { ResearchMissionV2 } from '../contracts/mission.js'
import {
  createMissionProductionSearchProvider,
  type MissionProductionSearchProviderOptions,
} from './createMissionProductionSearchProvider.js'
import type { AdmittedHttpGetFn } from './fetchSourceAccessPort.js'
import { createGovernedSourceAccessPort } from './governedSourceAccessPort.js'
import { resolveProductionCliDocumentHostByteCeilings } from './productionCliDocumentHostBudget.js'

export interface CreateProductionGovernedSourceAccessOptions
  extends Pick<
    MissionProductionSearchProviderOptions,
    'webSearchTransport' | 'exaLiteTransport' | 'fetchRepositoryTree'
  > {
  mission: ResearchMissionV2
  env?: NodeJS.ProcessEnv
  /** Injected GET for offline factory tests only; production uses governed HTTP. */
  admittedGet?: AdmittedHttpGetFn
}

/**
 * Production Research CLI access factory: mission production search + governed fetch.
 * Document host byte ceilings are opt-in via env (see `RESEARCH_DOCUMENT_ACQUISITION_SETUP.md`).
 */
export function createProductionGovernedSourceAccessForMission(
  options: CreateProductionGovernedSourceAccessOptions,
) {
  const env = options.env ?? process.env
  const searchProvider = createMissionProductionSearchProvider({
    mission: options.mission,
    env,
    ...(options.webSearchTransport ? { webSearchTransport: options.webSearchTransport } : {}),
    ...(options.exaLiteTransport ? { exaLiteTransport: options.exaLiteTransport } : {}),
    ...(options.fetchRepositoryTree ? { fetchRepositoryTree: options.fetchRepositoryTree } : {}),
  })
  const documentHost = resolveProductionCliDocumentHostByteCeilings(env)
  return createGovernedSourceAccessPort({
    mission: options.mission,
    searchProvider,
    ...(options.admittedGet ? { admittedGet: options.admittedGet } : {}),
    ...(documentHost
      ? {
          maxDocumentWireBytes: documentHost.maxDocumentWireBytes,
          maxDocumentDecompressedBytes: documentHost.maxDocumentDecompressedBytes,
        }
      : {}),
  })
}
