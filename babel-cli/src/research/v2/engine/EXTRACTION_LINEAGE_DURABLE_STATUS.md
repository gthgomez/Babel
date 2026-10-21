# Extraction lineage durable tests (B #404)

Integrated production helper: A `cfe0cd76` (`source_fetch_owner` write-time stamps + attempt-key admission).

Run: `npm run test:research-v2-extraction-lineage-durable` (no skip flags; not gated on main).

## 19-row matrix (honest outcomes; preserve d5632091 evidence until collision checkpoint)

| # | Row | Expected |
| --- | --- | --- |
| 1–9 | `retrievalExtractionLineage.test.ts` | **GREEN** |
| 10–11 | Shared `operation_id` sequential + interleaved e2e | **GREEN** |
| 12–18 | Nested same/distinct op filter + e2e | **GREEN** |
| 19 | Shared `passage_id`, distinct owners (failed A, succeeded B) | **RED** — ID-only allow-set admits both records / failed text in extract |

Row 19: await A per-record filter checkpoint (`2004cbeb` on #406); rerun this suite unchanged except API adaptation.

Obligation API (`95a87054`): `npm run test:research-v2-g-l2-bound-coverage` — original q3/q4 desired partial/tangential via labelled fixture + production `applySemanticSupportReview` path.
