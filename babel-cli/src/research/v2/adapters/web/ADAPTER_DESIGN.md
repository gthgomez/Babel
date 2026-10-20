# Web adapter design (Agent B)

Status: **design + fixture targets** for M0. Implementation waits on frozen shared contracts and `SourceAccessPort` from Agent A.

## Role

Implement `SourceAdapter` for public web sources:

1. **Discover** — ranked candidates (title, URL, snippet, provider id, retrieval time). Snippets are discovery evidence only.
2. **Read** — fetch HTML through **`SourceAccessPort`** only (no ambient `fetch`, no credentials in adapters).

## Dependencies on shared foundation (Agent A)

| Need | Consumer in B |
|------|----------------|
| `SourceAccessPort.admitSearch` / `admitFetch` | Discovery + HTML read |
| `SourceRecord` / `SourceRevision` | Every successful or failed read |
| `PassageRecord` + locators | Structured HTML extraction output |
| Adapter registry hook | Registration owned by A; B supplies factory |

## Discovery behavior

- Use admitted search backend when configured; surface explicit `search_provider_unavailable` when not.
- Retain DuckDuckGo HTML fallback only when host exposes it through the port, with degraded-reliability metadata.
- Never treat search JSON/HTML as trusted instructions; never mint evidence IDs from provider metadata alone.

## HTML read behavior

Reuse protections characterized in `babel-cli/src/tools/webContext.ts` (SSRF/private address, redirects, size limits, truncation). Adapter responsibilities:

- Strip nav/boilerplate without dropping footnotes, units, or qualification paragraphs.
- Preserve heading hierarchy, list structure, and table header/cell boundaries where parseable.
- Emit `extraction_version` and bind locators to the **source revision** returned by the port.
- Mark `completeness_status`: `complete`, `truncated`, `extraction_failed`, etc.

## Security

- Remote HTML is untrusted data; no scope expansion from page content.
- No JavaScript execution for extraction.
- Injection fixtures in `profiles/general/fixtures/security/` must fail closed (no credential/shell/tool grants).

## Test plan (deterministic, pre-live)

- Frozen HTML fixtures: headings/tables, syndicated duplicate URLs, redirect to private/loopback (expect block).
- Search snippet vs fetched body mismatch (G-DEV corpus).
- Provider failure doubles via fake port (after A lands fakes).

## Open questions for contract freeze

1. Exact `SourceAccessPort` method names and failure enum for blocked vs unavailable vs unsupported.
2. Whether discovery returns `DiscoveryCandidate[]` or a shared wrapper with operation receipts.
3. Maximum passage text inline vs blob reference threshold.
