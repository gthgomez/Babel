# Extraction lineage durable tests (B #404)

Integrated: A `cfe0cd76` (owner stamps) + **`2004cbeb`** (per-record filter, not passage_id allow-set).

Run: `npm run test:research-v2-extraction-lineage-durable` (no skip flags).

## 19-row matrix (acceptance unchanged; row 19 now green after 2004cbeb)

| # | Row | Expected |
| --- | --- | --- |
| 1–12 | `retrievalExtractionLineage.test.ts` (incl. collision + ownerless legacy) | **GREEN** |
| 13–14 | Shared `operation_id` sequential + interleaved e2e | **GREEN** |
| 15–18 | Nested same/distinct op filter + e2e (8 cases) | **GREEN** |
| 19 | Shared `passage_id`, distinct owners — filter + e2e | **GREEN** (per-record owner; succeeded bytes only) |

Receipt + TAP artifacts: `lineage-durable-matrix-2004cbeb-receipt.json` (pre `33e22803`; production `b7dfd848`; verified at **`73c5478c`** / tree `39b79c43…`, 24/24 exit 0). Collision e2e: failed-text zero + OK-text once unchanged; `passage_id` uses `includes` (not sole-id count); no payload-owner asserts.

Obligation API: `npm run test:research-v2-g-l2-bound-coverage` (separate; planner/slot wiring still host-owned).
