# Research v2 — production CLI document acquisition host budget

## Problem

Mission-selected PDFs declare per-URL `admitted_document_sources` wire/decompressed byte budgets and content pins (`missionDocumentAcquisitionPolicy.ts`). The fetch port intersects those mission budgets with **host** wire/decompressed ceilings.

Production CLI used host ceilings of `DEFAULT_MAX_ADMITTED_BYTES` (200 000) for every fetch. A mission declaring a ~2.2 MB complete paper therefore intersected to 200 KB and could not admit the full body under `require_complete_body`.

General web and repository fetch caps are unchanged.

## Mechanism (document-only host ceilings)

| Layer | Behavior |
| --- | --- |
| Mission | `selected_document_refs` + `admitted_document_sources` pin URL, digest, lengths, independent wire/decompressed budgets |
| Fetch policy | Applies only when the **actual fetch URL** matches a declared `document_ref` (not other `observed_urls`) |
| Host (production CLI) | Optional env raises ceilings **only** for document-policy fetches via `maxDocumentWireBytes` / `maxDocumentDecompressedBytes` |
| Intersection | `intersectDocumentFetchByteBudgets` — lower of host vs mission wins per dimension |
| Acquisition vs extraction | Fetch admission sets revision `completeness` from wire/decode truncation; PDF page/text extraction completeness is adapter-owned (`GeneralDocumentAdapter`) |

Factory: `createProductionGovernedSourceAccessForMission` (`createProductionGovernedSourceAccess.ts`), used by `researchV2MissionRun` production runs.

## Environment (operator authorization)

Set **both** (positive integers):

- `BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_WIRE_BYTES`
- `BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_DECOMPRESSED_BYTES`

Unset → document fetches use the same 200 KB host caps as web (bounded rejection for large pinned papers). When document host env is set, it applies to admitted-document fetches only; explicit port `maxAdmittedBytes` / `maxDecompressedBytes` still cap document allowances when provided.

Example for T-L2-shaped arXiv paper mission (`wire_byte_budget` / `decompressed_byte_budget` 2 300 000):

```bash
export BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_WIRE_BYTES=2300000
export BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_DECOMPRESSED_BYTES=2300000
```

Use values ≤ mission-declared budgets unless you intentionally want the intersection to remain lower. Values above mission budgets do not bypass mission caps.

Partial env (only one variable) fails fast at factory resolution.

## Not supported here

- Global `maxAdmittedBytes` increase for web fetch
- Campaign URL hardcoding in production code
- Test-only overrides in the production factory path
- Treating truncated PDF bodies as successful admission when `require_complete_body` is true

Pin/query/matrix campaign fixes are owned by Agent B.
