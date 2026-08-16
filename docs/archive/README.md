# Documentation Archive

<!--
status: ACTIVE
last_verified: 2026-08-15
-->
This directory preserves **historical documentation** from earlier stages of Babel's
evolution. Archived documents remain intentionally available for history, evidence, and
decision traceability.

## Reading archived material

- **Archived content may describe old commands or architecture** (e.g. `bl`, `babel-lite`,
  Lite/Full product identities, Local Mode, pre-open-source workflows). It is preserved
  because the reasoning and evidence remain valuable — not because it describes current
  behavior.
- **Archived content is not current product/runtime authority.** The current authority
  hierarchy lives in the live `/docs` indexes ([`docs/README.md`](../README.md),
  [`docs/architecture/README.md`](../architecture/README.md),
  [`docs/adr/README.md`](../adr/README.md)).
- **Historical links are preserved where feasible.** Some internal links may point at
  documents that have since been renamed or reorganized; if a link resolves to a moved
  location, treat the target as the successor.
- **Lifecycle markers** distinguish intent: `SUPERSEDED` documents were replaced by a
  named successor; `HISTORICAL` documents are retained for history/evidence only.

## Sections

| Section | Holds |
|---------|-------|
| [`cli/`](./cli/) | Retired user-facing CLI guides and contracts |
| [`architecture/`](./architecture/) | Retired product/architecture documents (Lite, Full, platform router fields) |
| [`guides/`](./guides/) | Retired guides (getting started, Lite discovery harness) |
| [`migrations/`](./migrations/) | Completed migration plans |
| [`release/`](./release/) | Pre-open-source release material |

Use the current `/docs` indexes for live guidance.
