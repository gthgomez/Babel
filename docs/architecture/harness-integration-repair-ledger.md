# Harness integration repair ledger

Audit source: *Babel harness architecture audit* (2026-10-12), revision `95f2cd35da0ce68c34a322e3ac32a49e5cef7d3e`.

Repair branch: `cursor/architecture-integration-repair-73b4` (base: current `main` at campaign start).

| ID | Evidence (current) | Implementation | Review | Verification |
|----|-------------------|----------------|--------|--------------|
| I01 | Confirmed | Unified `CompactionRequestContext`; manager/heuristic eligibility; heuristic fallback on manager noop/cannot_fit; manager commit validates serialized shrink | Lead + worker A cross-review | `architectureIntegrationRepair.test.ts`, `chatCompaction.test.ts` |
| I02 | Confirmed | `OpenCodeGoApiRunner` rethrows `PreparedRequestAdmissionError` | Worker A | `architectureIntegrationRepair.test.ts` |
| I03 | Confirmed | Preamble/map use `estimateTokens(conversation)` not cumulative `apiTokenCount` | Worker A | `architectureIntegrationRepair.test.ts` |
| I04 | Partial | `summarizationProvider` on `CompactionOptions`; env-only path unchanged when unset | Worker A | Unit injection path in compaction module |
| I05 | Confirmed | Manager `commitCompaction` uses `validateCommit` shrink check | Worker A | compaction commit integration |
| I06 | Confirmed | `runMutationAgentLoop` authorizes parsed patch targets | Worker B | `architectureIntegrationRepair.test.ts` |
| I07 | Confirmed | Pre/post hashes; parent promotes only clean + hash-delta changes | Worker B | child execution + mutation tests |
| I08 | Confirmed | Daemon crash recovery fails jobs with explicit recovery message (no silent requeue) | Worker B | `architectureIntegrationRepair.test.ts` |
| I09 | Latent | Not in this slice (ripgrep sync path remains) | — | Deferred |
| I10 | Confirmed | `snapshotComplete` on workspace identity; incomplete equal snapshots avoid `confirmed_no_change` | Worker B | mutationTools classification |
| I11 | Confirmed | Plan `read_only` enforced at executor kernel `tools.execute` | Worker B | kernel unit coverage TBD |
| I12 | Latent hardening | Expanded `MUTATING_TOOLS` exclusion set | Worker B | cache unit tests |
| I13–I16 | Design / incremental | Reducer documented as projection; no broad host port migration in this slice | Lead | Docs + follow-up PR scope |
