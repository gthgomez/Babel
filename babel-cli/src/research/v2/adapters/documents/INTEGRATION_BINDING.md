# Document adapter — integration binding (Agent B)

## Real frozen A contracts (required)

All adapter modules import **Agent A** `0ccd1733` modules:

- `../../ports/sourceAdapter.js` (includes `discover` + `read`)
- `../../ports/sourceAccessPort.js`
- `../../contracts/admittedContent.js`, `passages.js`, `sources.js`

There is **no** `frozenPorts*` alias file. Agent A `0ccd1733` `contracts/` and `ports/` are vendored on this branch (read-only); B-owned adapter paths import them directly.

## Runtime rules

- Bytes only via `SourceAccessPort.fetchContent`.
- `read` checks port `operationId` against the read for **every** fetch status before interpreting the result (foreign failures/cancellations are `contract_violation`, not propagated).
- On `ok`, binds admitted `operation_id`, `revision.source_id`, and provenance: `requested_url` must appear on the selected source `observed_urls`; `redirect_chain[0] === requested_url` and the chain must end at `final_url` (redirects may change the final URL; `final_url === requested_url` is not required).
- Pre- and post-await `AbortSignal` → `cancelled`.
- Plain extraction accepts **`text/plain` only** (not `text/html`).
- Fixture paths: `quarantinePath.ts` (rejects absolute paths and cross-drive escape on Windows).
