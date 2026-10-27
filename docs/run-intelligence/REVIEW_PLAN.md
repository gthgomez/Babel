# Local batch review execution plan

Goal: add `babel runs review --last-hours 24 [--until <ISO>] [--json]` over the existing catalog, without execution, network activity, or canonical evidence writes.

1. Add failing controlled CLI tests for task deduplication, established/unknown outcomes, ranking, immutable corrections, secret minimization and read-only operation.
2. Extract hashed singleton task identity and retry/completion-block counts from session events. Store receipt-bound annotations in the existing catalog. Multiple/absent identities remain unattributed; clarification coverage remains unknown.
3. Add a read-only report joining runs, outcomes, clusters, reviewed-fix fields and lineage. Preserve original assessments alongside append-only correction annotations. Rank by failed distinct tasks, affected distinct tasks, then cluster ID; cluster counts overlap.
4. Execute the ordinary CLI on controlled records and a nearby variation. Run regressions, canonical typecheck/build and publication gates. Request independent exact-head review through the parent; create a draft PR when gates permit.

Limits: incomplete historical normalization; execution/test status cannot certify task success. Missing identity, cost, clarification, outcomes and before/after proof stay unknown. Fix/correction assertions are review metadata, not verification. No scheduler activation.
