# Extraction slice candidate M1 (local, unpublished)

**Checkpoint preserved:** `general-document/0.1.0` plaintext path unchanged on published head semantics.

## Bounded scope

| Adapter | Media | Outcome |
|---------|--------|---------|
| `general-document/0.1.0` | `text/plain` | Unchanged reviewed plaintext integration |
| `general-document/0.1.0` | `application/pdf` | **Failed** `extraction_failed` — not implemented |
| `general-web/0.1.0` | `text/html` | **Ok** static heading-bounded passages (`general-static-html/0.1.0`) |
| `general-web/0.1.0` | discover | **Failed** `not_supported` — offline slice |

## Agent A coordination

- Register `generalAdapterCatalog` entries on `SourceAdapterRegistry` (A-owned).
- Mission → fetch → `read()` → passages already schema-valid; A owns cited-report loop.
- Shared: `readBinding`, `SourceAccessPort.fetchContent`, contract schemas @ `0ccd1733`.

## Fixtures

- HTML: `profiles/general/fixtures/dev-corpus/G-DEV-01/sources/plan-a.html`
- PDF negative: `adapters/documents/fixtures/two-page-sample.pdf`

## Not in scope

Live network/search, JS rendering, full PDF layout, publication push.
