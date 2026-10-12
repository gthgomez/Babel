# Harness integration repair ledger

Audit source: *Babel harness architecture audit* (2026-10-12), revision `95f2cd35da0ce68c34a322e3ac32a49e5cef7d3e`.

Repair branch: `cursor/architecture-integration-repair-73b4` (PR #370).

| ID | Evidence (current) | Implementation | Review | Verification |
|----|-------------------|----------------|--------|--------------|
| I01 | Confirmed | Unified `CompactionRequestContext`; manager/heuristic eligibility; heuristic fallback on manager noop/cannot_fit | Lead + worker A | `architectureIntegrationRepair.test.ts` (I01), `chatCompaction.test.ts` |
| I02 | Confirmed | `OpenCodeGoApiRunner` rethrows `PreparedRequestAdmissionError` | Worker A | `architectureIntegrationRepair.test.ts` (I02) |
| I03 | Confirmed | Preamble/map use `estimateTokens(conversation)` not cumulative `apiTokenCount` | Worker A | `architectureIntegrationRepair.test.ts` (I03) |
| I04 | Confirmed | `resolveCompactionSummarizationProvider` aligns compaction with Chat provider family; engine wires `summarizationProvider` + `compactionProviderId`; no ambient cross-provider route for OpenCode Go | Worker A | `architectureIntegrationRepair.test.ts` (I04), `chatEngine.ts` |
| I05 | Confirmed | Compaction commit accepts only when **final** serialized provider body is `prepareProviderRequest` **qualified**; rejects noop growth (wire + tokens); manager path requires token shrink | Worker A | `architectureIntegrationRepair.test.ts` (I05), `compactionCommit.test.ts` lifecycle suite |
| I06 | Confirmed | `runMutationAgentLoop` authorizes parsed patch targets | Worker B | `architectureIntegrationRepair.test.ts` (I06) |
| I07 | Confirmed | Pre/post hashes; parent promotes only clean + hash-delta changes | Worker B | child execution + mutation tests (prior PR slice) |
| I08 | Confirmed | Daemon crash recovery marks abandoned runs `failed` with explicit recovery message | Worker B | `architectureIntegrationRepair.test.ts` (I08) |
| I09 | Confirmed | Async ripgrep with `AbortSignal`; `RipgrepAbortedError`; cancelled grep does not fall back to pure JS | Worker B | `architectureIntegrationRepair.test.ts` (I09), `ripgrep.test.ts` |
| I10 | Confirmed | `snapshotComplete` on workspace identity; incomplete equal snapshots avoid `confirmed_no_change` | Worker B | mutationTools classification (prior slice) |
| I11 | Confirmed | Plan `read_only` at executor kernel `tools.execute` | Worker B | `architectureIntegrationRepair.test.ts` (I11), `kernel.test.ts` |
| I12 | Confirmed | Expanded `MUTATING_TOOLS` exclusion set for tool-result cache | Worker B | `toolResultCache.test.ts` |
| I13 | Confirmed | Read injection dedupe respects full-file identity and `contextEpoch`; range reads do not skip on path alone | Worker B | `architectureIntegrationRepair.test.ts` (I13), `readWindow.test.ts` |
| I14 | Confirmed | Run allowance reports `unknown` cost when no finite ceiling recorded (not zero/unlimited) | Worker B | `architectureIntegrationRepair.test.ts` (I14), `chatEngineLimits.test.ts` |
| I15 | Confirmed | Interrupted tool attempts remain in session log until explicit settlement | Worker B | `architectureIntegrationRepair.test.ts` (I15), `sessionEvents.test.ts` |
| I16 | Confirmed | Provider failure taxonomy + harness wall limit maps to `budget_exhausted` / harness cause (not success) | Worker B | `architectureIntegrationRepair.test.ts` (I16), `providerFailureReceipt.test.ts` |

## CI note (Windows chat-truth)

Run `38250794504` failed `chatEngine.lifecycleQualification.test.ts` with `run_dir_private_acl_unavailable:acl_verification_timeout` on `windows-latest` only; Ubuntu chat-truth passed. Mitigation: single retry with extended ACL verify timeout in `runtime/admission.ts` (environment-sensitive; not attributed to harness-integration diff).

## Residual limits

- Full process-tree settlement tests for search cancellation under load are not duplicated here (ripgrep abort path is covered).
- Broad host-port migrations beyond documented reducer projection boundaries remain out of scope for this PR; seams are tested at public entry points above.
