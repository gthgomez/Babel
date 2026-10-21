# Document adapter — integration binding (Agent B)

## Real frozen A contracts (required)

All adapter modules import **Agent A** `0ccd1733` modules:

- `../../ports/sourceAdapter.js` (includes `discover` + `read`)
- `../../ports/sourceAccessPort.js`
- `../../contracts/admittedContent.js`, `passages.js`, `sources.js`

There is **no** `frozenPorts*` alias file. Proof runs in a disposable worktree at A `0ccd1733` plus B-owned paths.

## Runtime rules

- Bytes only via `SourceAccessPort.fetchContent`.
- `read` binds outer/inner `operationId`, admitted `operation_id`, requested `source_id`, and provenance URLs.
- Pre- and post-await `AbortSignal` → `cancelled`.
- Plain extraction accepts **`text/plain` only** (not `text/html`).
- Fixture paths: `quarantinePath.ts` (rejects absolute paths and cross-drive escape on Windows).
