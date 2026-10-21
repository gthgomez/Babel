# Extraction lineage durable tests (B #404)

Integrated production helper: A `cfe0cd76` (`source_fetch_owner` write-time stamps + attempt-key admission).

Run: `npm run test:research-v2-extraction-lineage-durable` (no skip flags; not gated on main).

## 19-row matrix (honest outcomes after cfe0cd76)

| # | Row | Expected |
| --- | --- | --- |
| 1–9 | `retrievalExtractionLineage.test.ts` (unit + durable reopen) | **GREEN** |
| 10 | Shared `operation_id`, sequential failed→retry (e2e) | **GREEN** |
| 11 | Shared `operation_id`, interleaved intents (e2e) | **GREEN** (owner-scoped; distinct passage ids) |
| 12 | Nested same op, `a_then_b` filter reopen | **GREEN** |
| 13 | Nested same op, `a_then_b` e2e extract | **GREEN** |
| 14 | Nested same op, `b_then_a` filter reopen | **GREEN** |
| 15 | Nested same op, `b_then_a` e2e extract | **GREEN** |
| 16 | Nested distinct op, `a_then_b` filter reopen | **GREEN** |
| 17 | Nested distinct op, `a_then_b` e2e extract | **GREEN** |
| 18 | Nested distinct op, `b_then_a` filter + e2e | **GREEN** |
| 19 | **Shared `passage_id`**, distinct owners (failed A, succeeded B) filter + e2e | **RED** — `allowedSet<passage_id>` admits id once; failed record can inherit eligibility |

Row 19: A owns per-record filter correction (not ID-only set). Do not treat leakage as product acceptance.

Historical: pre-cfe bb774 red rows (prefix/revision OR) documented in git history; `45175254` snapshot preserved in history.

Semantic bound-coverage characterization (`2118a629` / `b2228115`) remains useful until A publishes general evidence-obligation API; then reconcile typed tests to expect partial/insufficient on original q3/q4 without preserving keyword-heuristic acceptance.
