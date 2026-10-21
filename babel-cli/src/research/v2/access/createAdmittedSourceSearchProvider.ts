import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { AdmittedSourceSearchProvider } from '../ports/admittedSourceSearchProvider.js'
import type { AdmittedSearchIndexEntry } from './admittedMissionSourceSearch.js'
import {
  createBabelConfiguredWebSearchProvider,
  defaultBabelWebSearchTransport,
  resolveProductionSearchProviderId,
  type BabelConfiguredSearchProviderId,
  type BabelWebSearchTransport,
} from './babelConfiguredWebSearch.js'
import type { ExaLiteSearchTransport } from './exaLiteSearchProvider.js'
import { createDeclaredIndexCorpusSearchProvider } from './declaredIndexCorpusSearchProvider.js'

export type ResearchSourceSearchMode = 'declared_index_corpus' | 'babel_configured_web'

export interface CreateAdmittedSourceSearchProviderOptions {
  mode: ResearchSourceSearchMode
  mission: ResearchMissionV2
  /** Required for declared_index_corpus — deterministic offline/tests only. */
  corpusIndex?: readonly AdmittedSearchIndexEntry[]
  /** Override configured provider (production); defaults from env via resolveProductionSearchProviderId. */
  configuredProviderId?: BabelConfiguredSearchProviderId
  /** Injected transport for tests; production uses admitted HTTP when omitted. */
  webSearchTransport?: BabelWebSearchTransport
  exaLiteTransport?: ExaLiteSearchTransport
  env?: NodeJS.ProcessEnv
}

export interface ResolvedAdmittedSourceSearchProvider {
  provider: AdmittedSourceSearchProvider
  mode: ResearchSourceSearchMode
  configuredProviderId: BabelConfiguredSearchProviderId | null
  limitations: readonly string[]
}

/**
 * Factory: corpus index for deterministic tests; babel_configured_web for production-shaped wiring.
 */
export function createAdmittedSourceSearchProvider(
  options: CreateAdmittedSourceSearchProviderOptions,
): ResolvedAdmittedSourceSearchProvider {
  if (options.mode === 'declared_index_corpus') {
    if (!options.corpusIndex) {
      throw new Error('declared_index_corpus mode requires corpusIndex')
    }
    return {
      mode: options.mode,
      configuredProviderId: null,
      limitations: ['declared_index_corpus_not_open_web_discovery'],
      provider: createDeclaredIndexCorpusSearchProvider(options.corpusIndex),
    }
  }

  const providerId =
    options.configuredProviderId ?? resolveProductionSearchProviderId(options.env ?? process.env)
  if (!providerId) {
    return {
      mode: options.mode,
      configuredProviderId: null,
      limitations: ['unsupported_babel_web_search_provider_configuration'],
      provider: {
        async search(request) {
          return {
            operationId: request.operationId,
            status: 'failed',
            failureCategory: 'search_provider_unavailable',
            message: 'BABEL_WEB_SEARCH_PROVIDER is not a supported admitted search provider',
          }
        },
      },
    }
  }

  const configured = createBabelConfiguredWebSearchProvider({
    providerId,
    webSearchTransport: options.webSearchTransport ?? defaultBabelWebSearchTransport(),
    exaLiteTransport: options.exaLiteTransport,
    env: options.env,
  })
  return {
    mode: options.mode,
    configuredProviderId: configured.providerId,
    limitations: configured.limitations,
    provider: configured,
  }
}
