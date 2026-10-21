# Extraction slice (local, unpublished)

**Published integration base:** `196098d9` (remote). **Local repaired head:** `2e81686d` (M1 HTML catalog + M2 PDF + review-defect repairs). Not pushed.

**Plaintext checkpoint preserved:** `general-document/0.1.0` `text/plain` path on published `196098d9` semantics.

## Bounded scope

| Adapter | Media | Outcome |
|---------|--------|---------|
| `general-document/0.1.0` | `text/plain` | Admitted inline UTF-8 lines (`general-plain-text/0.1.0`) |
| `general-document/0.1.0` | `application/pdf` | Per-page text via pdfjs (`general-pdf-text/0.1.0`); page limits; abort + cleanup |
| `general-web/0.1.0` | `text/html` | Static heading sections (`general-static-html/0.1.0`) |
| `general-web/0.1.0` | discover | `not_supported` (no live search in this slice) |

## Repaired-slice handoff (Agent A — registry + runtime dependency)

B does **not** edit `package.json`, `package-lock.json`, or A-owned registry sources. A owns **direct** `pdfjs-dist` dependency correction, **production-install smoke** where needed, and **`SourceAdapterRegistry` wiring**.

### Catalog export (real names)

Module: `babel-cli/src/research/v2/profiles/general/generalAdapterCatalog.ts`

| Export | Kind | Value / shape |
|--------|------|----------------|
| `generalAdapterCatalog` | const object | Registry-ready map (see below) |
| `generalAdapterCatalog.document.adapterId` | string | `general-document/0.1.0` (`GENERAL_DOCUMENT_ADAPTER_ID`) |
| `generalAdapterCatalog.document.factory` | `() => GeneralDocumentAdapter` | Document adapter instance |
| `generalAdapterCatalog.web.adapterId` | string | `general-web/0.1.0` (`GENERAL_WEB_ADAPTER_ID`) |
| `generalAdapterCatalog.web.factory` | `() => GeneralWebAdapter` | Web adapter instance |

Related adapter classes (if A registers by class instead of catalog factory):

- `GeneralDocumentAdapter` from `adapters/documents/generalDocumentAdapter.js`
- `GeneralWebAdapter` from `adapters/web/generalWebAdapter.js`

Extraction version strings returned on successful `read()`:

- `PLAIN_TEXT_EXTRACTION_VERSION` → `general-plain-text/0.1.0`
- `PDF_TEXT_EXTRACTION_VERSION` → `general-pdf-text/0.1.0`
- `STATIC_HTML_EXTRACTION_VERSION` → `general-static-html/0.1.0`

### PDF parser — version and import (required for A dependency pin)

**Observed today (B evidence, read-only):** `pdfjs-dist@5.4.296` is **transitive only** (`promptfoo` → `pdf-parse` → `pdfjs-dist`). See `review-artifacts/extraction-dependency-evidence.txt`.

**A action:** add a **direct** supported runtime dependency on **`pdfjs-dist@5.4.296`** (or a coordinator-agreed compatible 5.4.x pin that preserves the API below) and a **production-install** smoke path that can `import('pdfjs-dist/legacy/build/pdf.mjs')` without dev-only transitive hoisting.

**Importer (B slice — do not change without coordinated bump):**

```ts
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
```

**Runtime API used** (`adapters/documents/pdfFromAdmittedBytes.ts` → `passagesFromAdmittedPdf`):

| Step | Call |
|------|------|
| Load | `loadingTask = getDocument({ data: Uint8Array, useSystemFonts: true })` |
| Document | `doc = await loadingTask.promise` |
| Pages | `doc.numPages`; loop `doc.getPage(pageNum)` |
| Text | `(await page.getTextContent()).items` — text from items with `str` (ignore non-`str` items) |
| Cancel | `AbortSignal` → `PdfExtractionCancelled` via `throwIfPdfAborted` / adapter `cancelledRead` |
| Limits | `PDF_MAX_PAGES_PER_EXTRACTION` (512); inline text cap `MAX_INLINE_PASSAGE_CODE_POINTS` (32_000 code points per page passage) |
| Cleanup (always) | `await doc.destroy()`; `loadingTask.destroy()` in `finally` |

Admission: `application/pdf` only; `%PDF-` magic on admitted inline bytes (`pdfAdmission.ts`). IO remains **`SourceAccessPort.fetchContent`** → admitted inline bytes only.

### HTML / inline text (no new A dependency)

- Section locators: `htmlSectionLocator.ts` (`allocateSectionLocatorId`, `sectionSlugFromHeading`).
- Inline hash/truncate: `passageInlineText.ts` (`buildInlinePassageTextRef`, `MAX_INLINE_PASSAGE_CODE_POINTS`).

### Mission flow (unchanged)

Register `generalAdapterCatalog` on `SourceAdapterRegistry` (A-owned) → mission → `fetchContent` → adapter `read()` → schema-valid passages.

## Fixtures

- HTML: `profiles/general/fixtures/dev-corpus/G-DEV-01/sources/plan-a.html`
- PDF: `adapters/documents/fixtures/two-page-sample.pdf` (git blob `5469b80b…` at local head)

## Focused proof (B, not expanded here)

`review-artifacts/extraction-local-test-receipt.tap.txt` — 43 tests (documents + web adapters, inline text, locators, PDF cancel/cleanup). Delta: `review-artifacts/extraction-local-196098d9-to-HEAD.patch`.

## Not in scope

Live network/search, JS rendering, OCR, B edits to shared lockfiles, publication push.
