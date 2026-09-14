# Babel Run Intelligence status

Base SHA: `82fc080f71b87be117953284436fa5a8d6c502ac`
Schema version: `2`

Completed: isolated `runIntelligence` module; random logical-identity registry for new records; additive SQLite migrations; explicit availability semantics; immutable extraction receipts; read-only adapters for session events, verifier execution summaries, cost ledgers, and terminal summaries; idempotent ingestion; saved query registry; bounded `babel runs` operator commands; deterministic failure signatures/clusters; relational seams for cases, immutable case versions, datasets, evaluations, experiments, annotations, exposure, and lineage.

Important decisions: BRI is downstream-only; all historical run evidence remains read-only; raw task/prompt bodies are never catalog columns; raw source locators do not appear in normal query/show output; safe structured model/provider and terminal-status metadata may appear; `UNKNOWN` outcome is never counted as failure or success; retry/resume have no independent-trial promotion.

Known limitations: current adapters do not derive outcome observations, cost, checkpoints, benchmark results, review verdicts, or telemetry spans; therefore most comparison/rate queries correctly return `NOT_ESTABLISHED`. No archive, cloud, eviction, FTS reconstruction certification, recovery restore, compression, Parquet/DuckDB, or checkpoint delta experiment is implemented.

Vertical-slice audit: schema v3 adds failure-to-segment/evidence binding while retaining v1 identity mappings and v2 catalogs. A six-sample bounded public/private canary verified selected source bytes were unchanged after two ingestions; see `PHASE2_CANARY_RECEIPT.json`.

Outcome-authority audit: schema v4 records outcome authority class and revision-binding state, then derives immutable-in-spirit `task_outcome_assessments` using `bri.task-outcome.v1`. Only revision-bound `TASK_CORRECTNESS` observations from deterministic or independent authority can establish task PASS/FAIL. Current bounded historical samples contained terminal/control evidence but no qualifying task-correctness contract, so all six assessments remain `UNKNOWN` rather than being promoted from weaker evidence.

Tests: see the BRI unit test and final verification receipt for executed commands.
