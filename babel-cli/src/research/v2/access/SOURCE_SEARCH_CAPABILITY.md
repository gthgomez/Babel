# Source search capability labels

| Capability | Implementation | Open-web? |
|------------|----------------|-----------|
| **Declared-index corpus search** | `admittedMissionSourceSearch` / `createDeclaredIndexCorpusSearchProvider` | No — host manifest/index only (deterministic tests) |
| **Governed byte fetch** | `FetchSourceAccessPort` + `admittedHttpGet` | GET to admitted URLs only |
| **Babel configured web search** | `createAdmittedSourceSearchProvider({ mode: 'babel_configured_web' })` → default `exa_lite` (Exa + DDG fallback); override `duckduckgo_html_fallback` for DDG-only | Exa: governed `api.exa.ai` + receipts; DDG: same unofficial HTML endpoint as `handleWebSearch` — **limited coverage**, no SLA |
| **B-owned HTML/PDF extraction** | `adapters/web`, `adapters/documents` via `createCombinedResearchRegistries()` | Not Agent A |

See `RESEARCH_WEB_SEARCH_SETUP.md`. `BABEL_WEB_SEARCH_PROVIDER`: unset → `exa_lite`; `duckduckgo_html_fallback` → DDG only; `exa_lite` → explicit default; other values fail closed.

`GovernedSourceAccessPort` composes fetch + any injected `AdmittedSourceSearchProvider`. Bare `FetchSourceAccessPort.search` remains fail-closed until composed.
