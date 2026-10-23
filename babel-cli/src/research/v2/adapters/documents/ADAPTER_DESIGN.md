# Document adapter design (Agent B)

Status: **design + fixture targets** for M0. Implementation waits on frozen shared contracts and `SourceAccessPort` from Agent A.

## Role

`SourceAdapter` for local or port-fetched documents:

1. **Plain text** — UTF-8 with line-based locators.
2. **PDF (text-bearing)** — page locators required for acceptance (T-L2 joint scenario).

No OCR in first tranche unless separately reviewed; scanned PDFs return `unsupported` or `metadata_only` honestly.

## Read path

All bytes enter through **`SourceAccessPort.admitRead`** (or equivalent frozen name). Adapters:

- Detect media type and route parser.
- Compute content hash aligned with `SourceRevision`.
- Emit `PassageRecord` batches with explicit truncation/OCR/degraded flags.

## PDF extraction

- Prefer one maintained parser dependency **requested through Agent A** (lockfile owner).
- Handle scrambled reading order and simple tables; flag degraded extraction rather than inventing structure.
- Page locator format: `page` index (1-based) + optional bounding region when supported.

## Fixtures (owned)

- `fixtures/documents/sample-policy.txt` — policy date distinctions (G-DEV-03).
- `fixtures/documents/two-page-sample.pdf` — minimal valid PDF for locator tests (T-L2 prep).
- Malformed/truncated PDF cases added with adapter tests in M1.

## Security

- Reject path traversal and paths outside mission-admitted document roots (enforced by port + mission policy).
- No macro/script execution.
- Oversized files: bounded read with explicit truncation metadata.

## Open questions for contract freeze

1. Blob storage for large passages vs inline text cap.
2. License/retention fields required on `SourceRevision` for local files.
3. Whether `document` and `paper` kinds share one adapter entry with MIME routing.
