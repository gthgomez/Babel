# Source search capability labels

| Capability | Implementation | Open-web? |
|------------|----------------|-----------|
| **Declared-index corpus search** | `admittedMissionSourceSearch` / `createDeclaredIndexCorpusSearchProvider` | No — host manifest/index only |
| **Governed byte fetch** | `FetchSourceAccessPort` + `admittedHttpGet` | GET to admitted URLs only |
| **Open-web admitted search** | `AdmittedSourceSearchProvider` (integration; B-owned web adapter/catalog) | Yes — when provider is wired |
| **HTML/PDF extraction** | B-owned `adapters/web`, `adapters/documents` | Not Agent A |

`GovernedSourceAccessPort` composes fetch + any injected `AdmittedSourceSearchProvider`. Bare `FetchSourceAccessPort.search` remains fail-closed (`search_provider_unavailable`) until a provider is composed.
