# Source search capability labels

| Capability | Implementation | Open-web? |
|------------|----------------|-----------|
| **Declared-index corpus search** | `admittedMissionSourceSearch` / `createDeclaredIndexCorpusSearchProvider` | No — host manifest/index only (deterministic tests) |
| **Governed byte fetch** | `FetchSourceAccessPort` + `admittedHttpGet` | GET to admitted URLs only |
| **Babel configured web search** | `createAdmittedSourceSearchProvider({ mode: 'babel_configured_web' })` | `duckduckgo_html_fallback` (default) or `exa_lite` when `BABEL_WEB_SEARCH_PROVIDER=exa_lite` and `EXA_API_KEY` is set |
| **Exa lite** | `createExaLiteSearchProvider` / fallback composite | POST `https://api.exa.ai/search` (`type: lite`, cached highlights only). Snippets are **discovery**, not verified passages. Degrades to DuckDuckGo with explicit `receipt.degradation` on Exa failure/empty hits. |
| **B-owned HTML/PDF extraction** | `adapters/web`, `adapters/documents` via `createCombinedResearchRegistries()` | Not Agent A |

`BABEL_WEB_SEARCH_PROVIDER` — `duckduckgo_html_fallback` (default), or `exa_lite` (requires `EXA_API_KEY` presence). Other values fail closed with `search_provider_unavailable`.

`GovernedSourceAccessPort` composes fetch + any injected `AdmittedSourceSearchProvider`. Bare `FetchSourceAccessPort.search` remains fail-closed until composed.
