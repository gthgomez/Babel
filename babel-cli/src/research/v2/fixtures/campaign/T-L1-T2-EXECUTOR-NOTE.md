# T-L1 / T-L2 technical campaign execution ownership

**Agent B** runs authorized live technical campaigns (`research v2 run` + OpenRouter) after G-L1 attempt3 on `e912c2f3`. **Agent A does not** execute live smoke or spend for these cases.

| Scenario | Mission file | Pins record |
|----------|--------------|-------------|
| T-L1 architecture comparison | `T-L1-mission.json` | `T-L1-T-L2-PINNED-VERSIONS.json` |
| T-L2 paper + code (PDF locators) | `T-L2-mission.json` | same pins file |

Non-secret preflight: `npm run test:research-v2-technical-campaign-preflight`.

Offline production wiring proof (injected GitHub tree + document search routing): `technicalCampaignProductionWiring.test.ts` — **not** canonical live acceptance.

## Known blockers (A readiness, not repaired in this slice)

1. **Single retrieval candidate per engine pass** — T-L2 needs both pinned repository files and `selected_document_refs` PDF; production discover on the default path only exercises `repository_file` until multi-source retrieval exists.
2. **`selected_repository_refs`** — schema field is unused; second-repo architecture comparison must stay within one `pinned_target_repository` or await provider wiring.
3. **`paper` source class** — read adapter maps to `general-document`; discovery remains `document` + `selected_document_refs` (no open-web paper crawl).
