import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { AdmittedSourceSearchProvider } from '../ports/admittedSourceSearchProvider.js'
import type { SourceSearchRequest, SourceSearchResult } from '../ports/sourceAccessPort.js'
import {
  createDuckDuckGoHtmlFallbackSearchProvider,
  defaultBabelWebSearchTransport,
  resolveProductionSearchProviderId,
  type BabelWebSearchTransport,
} from './babelConfiguredWebSearch.js'
import {
  createPinnedRepositoryFileSearchProvider,
  type FetchPinnedRepositoryTree,
} from './pinnedRepositoryFileSearchProvider.js'

export interface MissionProductionSearchProviderOptions {
  mission: ResearchMissionV2
  webSearchTransport?: BabelWebSearchTransport
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
  const env = options.env ?? process.env
  const providerId = resolveProductionSearchProviderId(env)
  const web =
    providerId === null
      ? null
      : createDuckDuckGoHtmlFallbackSearchProvider({
          transport: options.webSearchTransport ?? defaultBabelWebSearchTransport(),
        })

  const limitations = [
    ...(web?.limitations ?? ['babel_configured_web_search_unavailable']),
    'pinned_repository_tree_listing_requires_public_github_api',
  ]

  return {
    limitations,
    async search(request: SourceSearchRequest, mission: ResearchMissionV2): Promise<SourceSearchResult> {
      const wantsRepo = request.sourceClasses.includes('repository_file')
      const wantsWeb = request.sourceClasses.includes('web')
      if (wantsRepo && !wantsWeb) {
        return repository.search(request, mission)
      }
      if (wantsWeb && !wantsRepo) {
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
