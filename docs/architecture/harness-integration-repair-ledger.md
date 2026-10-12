# Harness integration repair ledger

Audit source: *Babel harness architecture audit* (2026-10-12), revision `95f2cd35da0ce68c34a322e3ac32a49e5cef7d3e`.

Repair branch: `cursor/architecture-integration-repair-73b4` (PR #370).

| ID | Evidence | Implementation | Review | Verification |
|----|----------|----------------|--------|--------------|
| I01 | Confirmed | `CompactionRequestContext`; manager/heuristic eligibility; heuristic fallback on noop/cannot_fit | Lead + worker A | `architectureIntegrationRepair.test.ts` (I01), `chatCompaction.test.ts` |
| I02 | Confirmed | `OpenCodeGoApiRunner` execute/executeRaw/stream wrappers rethrow `PreparedRequestAdmissionError` before transport | Worker A + Bugbot (Composer 2.5 Fast; findings retained) | `architectureIntegrationRepair.test.ts` (I02): real adapter + mocked `fetch`, no `executeRaw` stub |
| I03 | Confirmed | Repo-map preamble uses `estimateTokens(conversation)` via `buildChatEngineRepoMapPreamble` | Worker A | `architectureIntegrationRepair.test.ts` (I03): repeated map requests; `chatEngine.ts` → `repoMapPreamble.ts` |
| I04 | Confirmed | `resolveCompactionSummarizationProvider` + engine wiring; no ambient cross-route for OpenCode Go | Worker A | `architectureIntegrationRepair.test.ts` (I04) |
| I05 | Confirmed | Compaction commit validates **native wire body** (messages + system + tools) against **provider** context window via `prepareProviderRequest`; harness `maxEstimatedTokens` is trigger-only | Worker A | `architectureIntegrationRepair.test.ts` (I05), `compactionCommit.test.ts`, `chatEngine.lifecycleQualification.test.ts` (admission recovery) |
| I06 | Confirmed | `runMutationAgentLoop` patch target authorization | Worker B | `architectureIntegrationRepair.test.ts` (I06) |
| I07 | Confirmed | Child effect receipts / hash-delta promotion | Worker B | mutation + child tests (prior slice) |
| I08 | Confirmed | Daemon crash recovery explicit `failed` (no silent requeue) | Worker B | `architectureIntegrationRepair.test.ts` (I08) |
| I09 | Confirmed | Async ripgrep + abort; grep tool forwards `context.signal`; 30s ceiling | Worker B + Bugbot | `architectureIntegrationRepair.test.ts` (I09), `ripgrep.test.ts` (7 native cases) |
| I10 | Confirmed | `snapshotComplete` workspace identity | Worker B | mutationTools tests (prior slice) |
| I11 | Confirmed | Plan read-only at executor kernel | Worker B | `architectureIntegrationRepair.test.ts` (I11), `kernel.test.ts` |
| I12 | Confirmed | Tool-result cache mutators; `localTools` invalidation wired to `TOOL_RESULT_CACHE_MUTATING_TOOLS` | Worker B + Bugbot | `toolResultCache.test.ts` |
| I13 | Confirmed | Read dedupe + `contextEpoch` | Worker B | `architectureIntegrationRepair.test.ts` (I13), `readWindow.test.ts` |
| I14 | Confirmed | Unknown cost allowance | Worker B | `architectureIntegrationRepair.test.ts` (I14) |
| I15 | Confirmed | Interrupted tool idempotency keys until settlement | Worker B | `architectureIntegrationRepair.test.ts` (I15), `sessionEvents.test.ts` |
| I16 | Confirmed | Provider failure taxonomy (connect vs read) + harness wall terminal reason | Worker B | `architectureIntegrationRepair.test.ts` (I16), `providerFailureReceipt.test.ts` |

## CI notes

- **ecaaa25** (prior head): lifecycle compaction/S07 failures traced to compaction admission using harness `maxEstimatedTokens` as provider ceiling — fixed by `resolveCompactionAdmissionContext` + native wire serializer (`chatEngineCompactionHost.ts`).
- **Windows ACL** (`acl_verification_timeout` at prior head): environment-sensitive; `runtime/admission.ts` adds one extended ACL verify retry. Not attributed to integration diff.
- **native-rg**: qualification script updated to **7** cases after abort-path test (coverage retained).

## Review receipts

- **Bugbot** (Composer 2.5 Fast, not user-requested model): ripgrep timeout + cache invalidation wiring — addressed in branch.
- **Independent review**: pending exact-head re-review after verification-gap commit (non-Fast Composer 2.5 lead).

## Honest limitations (not claimed complete)

- Broad host-port / reducer migration programs beyond documented projection boundaries and public-entry tests are **out of scope** for this PR.
- Full process-tree settlement under load for search cancellation is covered at abort/timeout seams, not exhaustive stress harnesses.
- Paid provider evaluations and release deployment were not authorized.
