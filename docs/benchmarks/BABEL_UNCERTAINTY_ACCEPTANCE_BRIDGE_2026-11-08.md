# Babel uncertainty and evidence recovery notes — 2026-11-08

## Baseline and scope

This change set is based on `origin/main` at `139547454966aa55aa74d222d201b3ca4997197b`. It addresses three reproduced recovery seams and integrates the two scoped-instruction fixes already prepared on separate branches. It does not claim to reproduce the CommandCode run directly: its structured evidence was not present in the shared workspace; the only available description was “2/2 checks passed, outcome `UNVERIFIED_PATCH`.”

## Changes

1. A newly executed, host-admitted verifier result now clears accumulated completion-gate strikes, including a red result that gives Babel fresh diagnostics to work from. The signal comes from the existing durable progress receipt and is only emitted for an executed authoritative verifier with a new semantic signature. Reads, repeated results, and model-authored progress claims do not clear strikes.
2. A later successful retry of the exact same tool and target clears stale typed blocking evidence. A success on a different action does not clear it, and a later typed failure reestablishes the block. The classifier still requires a model `BLOCKED` declaration and typed host-observed failure evidence.
3. Edit-intent parsing now recognizes “hidden tests” as a scoped protected artifact and “other files” as a scoped exclusion. It also ends that exclusion clause before a following explicit test command. These clauses do not grant mutation intent by themselves; global no-edit directives and unrelated commands remain read-only.
4. Command recovery evidence now includes host-observed working directory and completed-process state. A command success in another or unknown directory, a cached or merely started process, cannot clear the earlier block. Repeated typed failures are reordered by their latest observation before applying the 15-entry report limit.
5. Scoped-denial masking preserves the original source span, including whitespace. Without this, trimming the object clause before calculating its end could leave a later negated verb visible as positive edit intent.

## Verification

- Focused suites after follow-up review: 46 tests passed across `chatOperationPolicy.test.ts`, `chatBackgroundShellPolicy.test.ts`, and `r0TerminalAuthority.test.ts`. The streamed `ChatEngine` test executes a real failing `node --test` command from a nested cwd, confirms executor logs preserve cwd and process lifecycle, confirms a newly observed red verifier resets completion strikes before the next model turn, and confirms it does not certify completion. A background start is not treated as completion; a successful `await_command` logs the original command, cwd, and process completion, and only that matching completed result clears the corresponding blocked report evidence.
- `npm run typecheck` and `npm run build`: passed after the follow-up fixes.
- Streaming-loop regressions cover newly executed red evidence, repeated cached evidence, stale cache after workspace drift, alternating green/red results, and verifier rejection before process execution. Rejected, cached, or unchanged evidence does not reset strikes; only a new host-observed execution with changed semantic evidence does.
- `npm run typecheck`, `npm run build`, and `git diff --check` passed after the follow-up.
- Final `npm run test:chat-truth:raw` before the Linux thread-group refinement ran 1,108 assertions: 1,102 passed, 6 skipped, 0 failed. A final rerun after the refinement is pending below.
- Earlier `undoLane.test.ts` failures were reproduced with a writable `HOME`: the fixture's governance verification reports `[DENY_POLICY_INTEGRITY_DRIFT] Governance inspect failed (/workspace/Babel-uncertainty); session invalidated.` The lane then correctly refuses to certify the small fix. This is a checkout/governance fixture setup failure, not evidence that the verifier passed. Windows-only tree-kill tests were skipped on this Linux host, and PowerShell-specific checks were unavailable.

## Follow-up: process-group settlement and stale background receipts

The process-tree timeout failure reproduces on clean baseline `139547454966aa55aa74d222d201b3ca4997197b`. Initial inspection found zombie records retained by container PID 1. Review then exposed a more serious case: a native fixture called `pthread_exit` on its thread-group leader while a worker remained live (`/proc` leader state `Z`, worker state `S`). The prior single-leader scan missed that runnable worker. Linux checks now inspect every task in each group member, fail closed on incomplete/disappearing task records, and require identical all-dead thread snapshots across a stability interval before reporting group exit. A native multithreaded negative test confirms a zombie leader with a live worker still blocks; a positive test confirms group settlement only after all worker threads exit. The sandbox timeout path no longer reports a successful terminal result when it cannot establish settlement.

Follow-up review caught a stability-window liveness bug: each 10ms poll replaced the first-observed timestamp, preventing an unchanged snapshot from ever reaching the 20ms threshold. The scanner now retains the timestamp for an unchanged fingerprint and resets it only when the snapshot changes; live/incomplete observations still fail closed. A process-group test exercises live snapshots over the polling interval followed by termination and stable settlement.

A further adversarial review found that `/proc` entries disappearing between directory enumeration and `stat` were treated as absent. Such snapshots now remain incomplete and cannot certify group exit. Synthetic procfs tests cover missing stat records, stable empty/all-zombie snapshots, and a changed live snapshot resetting the stability window. Background awaits now compare failure and recovery using the host execution's dispatch position: the reproduced sequence `start A; start B; collect A failure; collect B success` resolves correctly. The new regression failed before the reducer fix and passes afterward.

Latest follow-up validation: focused procfs and blocked-report suites passed 41/41; `npm run typecheck` and `npm run build` passed; `npm run test:chat-truth:raw` passed 1,103, skipped 6, failed 0 (1,109 total). `git diff --check` passed. Windows/PowerShell limitations remain unchanged.

Background completion receipts now carry a host-owned `processExecutionId` linking `await_command` to the corresponding start log. The blocked-report reducer compares actual chronological dispatch positions to failures and remembers the latest successful execution even after clearing a block. A delayed first await or re-await for an older failed job cannot resurrect a later same-command/cwd success; an older success cannot clear a newer failure; a distinct job started after a failure can.

Streaming coverage now exercises a cached verifier receipt (strikes remain), invalidation after workspace drift (the verifier re-executes and changed host evidence resets strikes), and an alternating red verifier (nonzero exit remains unverified while fresh diagnostic progress resets stale strikes). The separate end-to-end red-verifier test explicitly asserts exit code 1.

Focused validation after this follow-up: 70 tests, 67 passed, 3 platform skips, 0 failed across process-tree, sandbox termination, Chat streaming, background logging, and blocked-report suites. `npm run typecheck` and `npm run build` passed. Final `npm run test:chat-truth:raw` completed with 1,103 passed, 6 skipped, 0 failed across 1,109 tests. Windows tree-kill and PowerShell scenarios remain unavailable on this Linux host.
- Full `npm run test:unit`: started and exercised the modified suites successfully, but was interrupted after 5 minutes because the suite stalled without output. Before interruption, unrelated environment-sensitive failures were reported in background process-tree termination, offline plan-lane assumptions, and undo-lane fixtures. This is not a passing full-suite result.
- `pwsh scripts/agent-preflight.ps1` is unavailable because PowerShell is not installed in the execution environment.
- No provider inference was used.

## Acceptance evidence and remaining gap

Babel already binds required verifier commands to host-owned task/session/context and current workspace revision, and rejects stale, failed, skipped, or irrelevant receipts. A green test summary alone is not enough to establish `VERIFIED_COMPLETE`. The CommandCode report’s 2/2-but-unverified case cannot be diagnosed without its task contract, required verifier list, receipts, current revision, and terminal reason. Do not promote such a result based only on the count of green checks. The next concrete step is to replay that exact evidence bundle through the existing completion proof selector and determine which requirement is uncovered or which provenance field is missing.

The suspected broad `NEEDS_HUMAN_DECISION` behavior and requirement-to-verifier binding were not changed because the available evidence did not establish a safe reproducible false positive or a concrete missing-criterion mapping. Decision gates and fail-closed completion remain intact.
