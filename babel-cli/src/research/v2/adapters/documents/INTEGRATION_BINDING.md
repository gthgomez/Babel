# Document adapter — integration binding (Agent B)

## Temporary compile aliases (branch-only)

`../frozenPorts0ccd1733.ts` duplicates **shapes only** so adapters typecheck before Agent A’s `ports/` and `contracts/` land on this branch. It is **not** acceptance coverage and **not** a second contract.

## Required integration swap (before integrated acceptance)

Replace every import from `../frozenPorts0ccd1733.js` with Agent A frozen paths:

| Temporary alias | Integrated import (A @ `0ccd1733`) |
|-----------------|-------------------------------------|
| `SourceAccessPort`, `SourceFetchRequest`, `SourceFetchResult` | `../../ports/sourceAccessPort.js` |
| `SourceAdapter`, `SourceAdapterReadRequest`, `SourceAdapterReadResult` | `../../ports/sourceAdapter.js` |
| `AdmittedContent`, `PassageRecord`, `SourceRecord`, `SourceRevision` | `../../contracts/admittedContent.js`, `passages.js`, `sources.js` |

Integrated acceptance tests must **compile against real A exports** and delete `frozenPorts0ccd1733.ts`.

## Runtime rules (unchanged at integration)

- Bytes enter only via `SourceAccessPort.fetchContent` (no ambient fetch).
- Fixture paths use `quarantinePath.ts` under B-owned `profiles/general/fixtures/`.
- Raw admitted bytes are validated (length, SHA-256, UTF-8) before extraction.
