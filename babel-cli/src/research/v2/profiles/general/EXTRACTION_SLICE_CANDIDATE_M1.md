# Extraction slice (local, unpublished)

**Plaintext checkpoint preserved:** `general-document/0.1.0` `text/plain` path on published `196098d9` semantics.

## Bounded scope

| Adapter | Media | Outcome |
|---------|--------|---------|
| `general-document/0.1.0` | `text/plain` | Reviewed admitted inline UTF-8 lines |
| `general-document/0.1.0` | `application/pdf` | Per-page text via pdfjs (`general-pdf-text/0.1.0`); page limits; abort + cleanup |
| `general-web/0.1.0` | `text/html` | Static heading sections (`general-static-html/0.1.0`) |
| `general-web/0.1.0` | discover | `not_supported` (no live search in this slice) |

## Agent A coordination

- Register `generalAdapterCatalog` on `SourceAdapterRegistry` (A-owned).
- Mission → `fetchContent` → adapter `read()` → schema-valid passages.

## Fixtures

- HTML: `profiles/general/fixtures/dev-corpus/G-DEV-01/sources/plan-a.html`
- PDF: `adapters/documents/fixtures/two-page-sample.pdf`

## Not in scope

Live network/search, JS rendering, OCR, publication push.
