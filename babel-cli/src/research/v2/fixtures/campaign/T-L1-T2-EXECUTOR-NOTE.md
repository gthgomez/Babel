# T-L1 / T-L2 technical campaign execution ownership

**Agent B** runs authorized live technical campaigns (`research v2 run` + OpenRouter) after G-L1 attempt3 on `e912c2f3`. **Agent A does not** execute live smoke or spend for these cases.

| Scenario | Mission file | Pins record |
|----------|--------------|-------------|
| T-L1 architecture comparison | `T-L1-mission.json` | `T-L1-T-L2-PINNED-VERSIONS.json` |
| T-L2 paper + code (PDF locators) | `T-L2-mission.json` | same pins file |

Non-secret preflight: `npm run test:research-v2-technical-campaign-preflight`.

**T-L1 discover query (verified 2026-10-21):** do not rely on CLI default first-eight-word query (`0` repository path hits). Mission pins carry optional `discover_query` (trimmed nonempty at parse; whitespace-only rejected). `T-L1-mission.json`: Babel `persistence durableresearchstore.ts` → first tree hit `durableResearchStore.ts`; LangGraph `pregel checkpoint` → `_checkpoint.py` (not `libs checkpoint` → conformance Makefile). Recorded tree verification: `review-artifacts/t-l1-discover-query-tree-first-hit.json`. Host `--discover-query` remains fallback when a pin omits `discover_query`. LangGraph commit `3cd57c03…` (tree `a8aa3b13…`).

Offline production wiring proof (injected GitHub tree + document search routing): `technicalCampaignProductionWiring.test.ts` — **not** canonical live acceptance.

## Composed retrieval (post `fb1c44aa`)

Technical missions use **composed retrieval** when slots are planned: each declared repository pin, each `selected_document_ref`, and each unsupported admitted class (e.g. `structured`) gets distinct search/fetch operation IDs. Unsupported classes settle as `not_supported` limitations while other slots proceed.

## Remaining blockers

1. **arXiv PDF (~2.2MB, mutable locator + content digest `bdfaa68d…`)** — declare `source_policy.admitted_document_sources` on the mission (see `T-L2-mission.json`); production resolves via `missionDocumentAcquisitionPolicy` bound to the **actual fetch URL** (intersect host wire/decompressed ceilings with mission budgets). General web cap (`DEFAULT_MAX_ADMITTED_BYTES` 200000) unchanged unless host raises it. Deterministic tests use `papers/mutable-locator-synthetic.pdf` + manifest; full arXiv bytes live in external cache (`papers/1706.03762.manifest.json`, not tracked in Git).
2. **`paper` discovery** — use `document` + `selected_document_refs` (no open-web paper crawl).
3. **Live GitHub tree + PDF fetch** — B-owned campaign execution; injected-transport composition tests were run by A and do not establish live retrieval acceptance.
