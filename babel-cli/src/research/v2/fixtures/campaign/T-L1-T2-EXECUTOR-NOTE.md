# T-L1 / T-L2 technical campaign execution ownership

**Agent B** runs authorized live technical campaigns (`research v2 run` + OpenRouter) after G-L1 attempt3 on `e912c2f3`. **Agent A does not** execute live smoke or spend for these cases.

| Scenario | Mission file | Pins record |
|----------|--------------|-------------|
| T-L1 architecture comparison | `T-L1-mission.json` | `T-L1-T-L2-PINNED-VERSIONS.json` |
| T-L2 paper + code (PDF locators) | `T-L2-mission.json` | same pins file |

Non-secret preflight: `npm run test:research-v2-technical-campaign-preflight`.

Offline production wiring proof (injected GitHub tree + document search routing): `technicalCampaignProductionWiring.test.ts` — **not** canonical live acceptance.

## Composed retrieval (post `fb1c44aa`)

Technical missions use **composed retrieval** when slots are planned: each declared repository pin, each `selected_document_ref`, and each unsupported admitted class (e.g. `structured`) gets distinct search/fetch operation IDs. Unsupported classes settle as `not_supported` limitations while other slots proceed.

## Remaining blockers

1. **arXiv PDF (~2.2MB, mutable locator + content digest `bdfaa68d…`)** — declare `source_policy.admitted_document_sources` on the mission (see `T-L2-mission.json`); production resolves via `missionDocumentAcquisitionPolicy` bound to the **actual fetch URL** (intersect host wire/decompressed ceilings with mission budgets). General web cap (`DEFAULT_MAX_ADMITTED_BYTES` 200000) unchanged unless host raises it. Offline bytes + manifest: `fixtures/campaign/papers/1706.03762.pdf`.
2. **`paper` discovery** — use `document` + `selected_document_refs` (no open-web paper crawl).
3. **Live GitHub tree + PDF fetch** — B-owned campaign execution; A proves injected-transport composition only.
