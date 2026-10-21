# A canonical branch adoption handoff (B candidate `cce13455`)

**B PR branch:** `cursor/agent-b-general-fixtures-f617`  
**Candidate HEAD:** `cce1345545a65399a5881e125ef55ac729b6e81a`  
**Tree:** `aebef55071c8176065e55f31e60963b72a91cd06`

## Preserve A semantic / contract work

Cherry-pick or merge **only** the reviewed B deltas onto A’s latest canonical branch; do **not** overwrite A-owned semantic criteria, engine canonicalization, or document/lifecycle production paths.

### Shared contract (single field — reconcile with A edits)

`babel-cli/src/research/v2/contracts/common.ts` — `PinnedRepositoryRefSchema.discover_query`:

- `refine` → nonempty after trim (whitespace-only **rejects parse**)
- `transform` → trim stored value
- optional; host `discoverQuery` remains fallback when field **omitted**

Exact snippet: `review-artifacts/a-adopt-discover-query-schema-delta.md`

### B-owned (safe to take as-is)

- `engine/technicalRetrievalComposition.ts` — `resolveRepositorySlotDiscoverQuery` + slot planning
- Campaign fixtures / reciprocal tests / review artifacts under `review-artifacts/t-l1-*`
- HTML extraction slice (`5628e90e` lineage) — unchanged in `cce13455` correction commit

### Production proof on candidate (this run)

| Command | Exit | Log |
|---------|------|-----|
| `npm run typecheck` (in `babel-cli/`) | 0 | `b-cce13455-production-typecheck.stdout.log` |
| `npm run build` (in `babel-cli/`) | 0 | `b-cce13455-production-build.stdout.log` |

Receipt: `b-cce13455-production-typecheck-build-receipt.json`

Focused B slice (not full suite): **21/21** — `b-focused-extraction-query-test-run.json`

## Explicitly out of scope for B on A branch

- No additional shared production edits beyond `discover_query` validation + composition fallback behavior already reviewed.
- No rerun of superseded C `5628` replay failure (removed test lines; fixed in `0195ec26`).
