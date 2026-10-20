# Web acquisition characterization (baseline reuse)

Status: read-only analysis of existing `babel-cli/src/tools/webContext.ts` for Research V2 adapter design. **No shared port edits.** Await frozen `SourceAccessPort` + adapter read seam.

## Search (`handleWebSearch`)

- **Backend:** DuckDuckGo HTML (`https://duckduckgo.com/html/`), not a paid search API.
- **Limits:** default 5 results, max 10 (`DEFAULT_MAX_SEARCH_RESULTS`, `MAX_SEARCH_RESULTS`).
- **Timeout:** 15s `AbortSignal.timeout`.
- **Output:** parsed titles/URLs via `parseDuckDuckGoHtml`; snippets are HTML-derived discovery leads.
- **Caching:** per-run `external/web-cache` keyed by request hash.
- **Campaign label:** degraded reliability; cannot claim production search SLA from this alone.

## Fetch (`handleWebFetch` / pinned HTTP)

- **Policy:** `evaluateNetworkHostPolicy` on hostname; blocks private/loopback unless `BABEL_WEB_ALLOW_PRIVATE=1`.
- **DNS:** resolves all addresses; rejects if any resolve to private (`assertPublicNetworkTarget`).
- **Pinning:** custom `lookup` pins to pre-resolved public addresses (mitigate DNS rebinding).
- **Size:** `BABEL_WEB_MAX_BYTES` env (default 200_000); streaming truncate + `truncated` flag.
- **Extraction:** `htmlToText` strips script/style/tags — **no** JS execution; structure (headings/tables) **not** preserved (flat text). V2 HTML adapter must improve structure while reusing admission policy.

## Mapping to V2 contracts (when integrated)

| V2 concept | Baseline behavior |
|------------|-------------------|
| `SourceSearchHit.completeness` | `snippet` (search); not primary read |
| `SourceRevision.completeness` | `truncated` when fetch cap hit |
| `failureCategory` | map HTTP/timeout/policy errors to port enums |
| Injection | `INJECTION_WARNING` constant; treat body as untrusted |

## B-owned next steps (local, post-contract)

- Fixture-driven tests for structured extraction against frozen HTML in `profiles/general/fixtures/`.
- Do not call live DuckDuckGo until coordinator releases live scenarios.
