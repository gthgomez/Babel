import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { AdmittedSourceSearchProvider } from '../ports/admittedSourceSearchProvider.js'
import type { SourceSearchRequest, SourceSearchResult } from '../ports/sourceAccessPort.js'
import {
  createBabelConfiguredWebSearchProvider,
  defaultBabelWebSearchTransport,
  resolveProductionSearchProviderId,
  type BabelWebSearchTransport,
} from './babelConfiguredWebSearch.js'
import type { ExaLiteSearchTransport } from './exaLiteSearchProvider.js'
import {
  createPinnedRepositoryFileSearchProvider,
  type FetchPinnedRepositoryTree,
} from './pinnedRepositoryFileSearchProvider.js'
import { createMissionSelectedDocumentSearchProvider } from './missionSelectedDocumentSearchProvider.js'

export interface MissionProductionSearchProviderOptions {
  mission: ResearchMissionV2
  webSearchTransport?: BabelWebSearchTransport
  exaLiteTransport?: ExaLiteSearchTransport
  fetchRepositoryTree?: FetchPinnedRepositoryTree
  env?: NodeJS.ProcessEnv
}

/**
 * Production admitted search: pinned GitHub tree listing for repository_file; configured web for web.
 */
export function createMissionProductionSearchProvider(
  options: MissionProductionSearchProviderOptions,
): AdmittedSourceSearchProvider & { limitations: readonly string[] } {
  const repository = createPinnedRepositoryFileSearchProvider({
    ...(options.fetchRepositoryTree ? { fetchTree: options.fetchRepositoryTree } : {}),
  })
  const documents = createMissionSelectedDocumentSearchProvider()
  const env = options.env ?? process.env
  const providerId = resolveProductionSearchProviderId(env)
  const web =
    providerId === null
      ? null
      : createBabelConfiguredWebSearchProvider({
          providerId,
          webSearchTransport: options.webSearchTransport ?? defaultBabelWebSearchTransport(),
          exaLiteTransport: options.exaLiteTransport,
          env,
        })

  const limitations = [
    ...(web?.limitations ?? ['babel_configured_web_search_unavailable']),
    'pinned_repository_tree_listing_requires_public_github_api',
    'document_discovery_limited_to_mission_selected_document_refs',
  ]

  return {
    limitations,
    async search(request: SourceSearchRequest, mission: ResearchMissionV2): Promise<SourceSearchResult> {
      const wantsRepo = request.sourceClasses.includes('repository_file')
      const wantsWeb = request.sourceClasses.includes('web')
      const wantsDocument = request.sourceClasses.includes('document')
      if (wantsRepo && !wantsWeb && !wantsDocument) {
        return repository.search(request, mission)
      }
      if (wantsDocument && !wantsWeb && !wantsRepo) {
        return documents.search(request, mission)
      }
      if (wantsWeb && !wantsRepo && !wantsDocument) {
        if (!web) {
          return {
            operationId: request.operationId,
            status: 'failed',
            failureCategory: 'search_provider_unavailable',
            message: 'configured web search provider is unavailable for this host',
          }
        }
        return web.search(request, mission)
      }
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: 'search_provider_unavailable',
        message: 'mission production search requires a single source class per discover request',
      }
    },
  }
}
