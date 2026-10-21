# Exa search receipt — B provider boundary → A runtime propagation

**B owns:** `AdmittedSourceSearchProvider` search results through `SourceAccessPort#search`.

**A owns (not duplicated on B):** `SourceDiscoverResult`, `GeneralWebAdapter`, durable operation completion, synthesis/report fields.

## Contract starting point

`SourceSearchProviderReceipt` on `SourceSearchResult` (`ok` **or** `failed`):

| Field | Type | Notes |
| --- | --- | --- |
| `configured_provider_id` | string | e.g. `exa_lite` |
| `effective_provider_id` | string | `exa_lite` or `duckduckgo_html_fallback` after degradation |
| `exa_participation` | enum | `exa_primary_ok` \| `exa_primary_empty_billed` \| `exa_primary_failed` \| `exa_degraded_fallback` |
| `degradation` | object? | `from_provider_id`, `to_provider_id`, `reason` (never silent fallback) |
| `exa_lite` | object? | Sanitized metadata below |

### `exa_lite` (sanitized)

| Field | Type |
| --- | --- |
| `request_id` | string \| null |
| `resolved_search_type` | string \| null |
| `warnings` | `SourceSearchExaLiteDiagnosticRecord[]` (`code`, `path`, `message`, bounded `details`) |
| `notices` | `SourceSearchExaLiteDiagnosticRecord[]` |
| `estimated_cost_dollars` | number \| null (provider estimate, **not** an invoice) |
| `estimated_cost_detail` | Record<string, number> \| null |

**Invariant:** When Exa returns HTTP 200 with billing metadata but zero in-policy hits (`exa_primary_empty_billed`), B **preserves** `receipt` even if DuckDuckGo fallback subsequently fails.

## Suggested A mapping (non-normative)

- Copy `receipt` onto discover operation diagnostics / `SourceDiscoverResult.search_provider_receipt`.
- Surface `exa_participation` + `degradation.reason` in report limitations when degraded.
- Do not treat `exa_lite` snippets as passages; governed `fetchContent` remains evidence authority.

Canonical Zod: `contracts/sourceSearchProviderReceipt.ts` (keep in sync with B `ports/sourceAccessPort.ts` interfaces).
