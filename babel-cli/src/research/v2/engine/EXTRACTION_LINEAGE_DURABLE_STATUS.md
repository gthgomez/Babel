# Extraction lineage durable tests (B #404)

Integrated production helper: A `bb7741e86c2246617c9fb89f1baf7c97b028a470` (`retrievalExtractionLineage.ts` + e2e extract wiring).

Run: `npm run test:research-v2-extraction-lineage-durable` (no skip flags; not gated on main).

| Area | Expected |
| --- | --- |
| `retrievalExtractionLineage.test.ts` | GREEN |
| Shared `operation_id`, sequential failed→retry | GREEN |
| Shared `operation_id`, interleaved intents before completion | **RED** (prefix ownership admits failed attempt orphan) |
| Nested attempts + revision ownership (`a_then_b`, same or distinct op) | **RED** (revision-set OR across outer succeeded span) |
| Nested `b_then_a` (inner A completes before outer B fails) | GREEN with current bb774 |

Pre-dd544 blocked-regression alias now runs this suite; historical dd544 characterization is not a separate acceptance gate.
