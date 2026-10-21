# Source search capability labels

| Capability | Implementation | Open-web? |
|------------|----------------|-----------|
| **Declared-index corpus search** | `admittedMissionSourceSearch` / `createDeclaredIndexCorpusSearchProvider` | No — host manifest/index only (deterministic tests) |
| **Governed byte fetch** | `FetchSourceAccessPort` + `admittedHttpGet` | GET to admitted URLs only |
| **Babel configured web search** | `createAdmittedSourceSearchProvider({ mode: 'babel_configured_web' })` → `duckduckgo_html_fallback` | Same unofficial DuckDuckGo HTML endpoint as `handleWebSearch` — **limited coverage**, no paid API key, no SLA, parser-fragile |
| **B-owned HTML/PDF extraction** | `adapters/web`, `adapters/documents` via `createCombinedResearchRegistries()` | Not Agent A |

`BABEL_WEB_SEARCH_PROVIDER` — only `duckduckgo_html_fallback` (or unset) is supported today; other values fail closed with `search_provider_unavailable`.

`GovernedSourceAccessPort` composes fetch + any injected `AdmittedSourceSearchProvider`. Bare `FetchSourceAccessPort.search` remains fail-closed until composed.
