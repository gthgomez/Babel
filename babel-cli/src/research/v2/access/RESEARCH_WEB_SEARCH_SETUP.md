# Research v2 web search configuration

## Default (normal Research runs)

Admitted open-web discovery for Research v2 (`babel_configured_web` / mission production search) defaults to **`exa_lite`**: governed Exa Lite search with **explicit DuckDuckGo HTML fallback** on Exa failure, empty billed results, or zero in-policy hits. Effective provider and degradation are recorded on `SourceSearchProviderReceipt` (see `EXA_SEARCH_RECEIPT_HANDOFF.md`).

Resolution: `resolveProductionSearchProviderId()` in `babelConfiguredWebSearch.ts` → `DEFAULT_RESEARCH_WEB_SEARCH_PROVIDER_ID` (`exa_lite`) when `BABEL_WEB_SEARCH_PROVIDER` is unset.

This does **not** change the standalone Babel `web_search` tool default (`handleWebSearch` / DuckDuckGo HTML only).

## Overrides

| `BABEL_WEB_SEARCH_PROVIDER` | Behavior |
| --- | --- |
| *(unset)* | `exa_lite` composite (Exa primary + DDG fallback) |
| `exa_lite` | Same as default |
| `duckduckgo_html_fallback` | DDG HTML only (no Exa attempt) |
| any other value | Fail closed (`search_provider_unavailable`) |

## `EXA_API_KEY` (runtime secret)

- Required for Exa Lite HTTP calls. Read at runtime from the process environment (`EXA_API_KEY`); never committed to the repo.
- When the key is **missing**, the Exa leg fails closed without live calls; the composite provider **degrades to DDG** and receipts record degradation (not silent fallback).
- **Cursor Cloud Agents:** secrets saved in the dashboard apply to **new** agent runs in that environment. An agent that was already running does **not** automatically receive a key saved after launch; start a **fresh** validation executor to pick up `EXA_API_KEY`.

## Validation note

A one-shot connectivity probe may set `BABEL_WEB_SEARCH_PROVIDER=exa_lite` explicitly in its process. That matches the new default behavior but is not required once this default is deployed.
