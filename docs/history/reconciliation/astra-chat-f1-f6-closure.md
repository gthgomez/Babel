<!--
status: ACTIVE
last_verified: 2026-09-14
-->

# Astra Chat F1–F6 follow-up closure

Date: 2026-09-14
Base: `origin/main` `017ec8cc28dbfbabf8138794096b1af00212b474`
Decision: **RUN AFTER SPECIFIC FIXES**

This is the combined Chat follow-up after PRs #182/#183/#184. Those branches
were not merged into main. Valid repairs were reimplemented on this branch
from current main and verified on production Chat paths.

## F1–F6

| Finding | Baseline | Fix | Production test | Status |
| --- | --- | --- | --- | --- |
| F1 compaction tail | Capsule-only durable write; sequential batches could merge | Retain complete tool cycles by durable identity after the capsule | `compactionOracle.test.ts`, providerMessages P02/P03 | PASS |
| F2 mode parity | Reused TUI engine skipped factory stack/intent injection | `ChatEngine.applyTurnPreparation` + durable intent-plan record | `chatPreparationParity.test.ts` captures actual OpenCode Go POST | PASS |
| F3 provider protocol | Missing `[DONE]` threw; incomplete tools could synthesize `{}` | Typed error events; no `{}`; deadline covers body; invalid history sends zero requests | `providerFaultTable.test.ts` rows 1–20 | PASS |
| F4 terminal cause | Unknown exception → `AGENT_FAILURE`; missing terminal → `CANCELLED` | Unknown omits outcome; `{ type: 'cancelled' }` is CANCELLED | `chatTerminalTruth.test.ts`, D12/D13 | PASS |
| F5 budgets | Helpers not wired into ChatEngine; no-limiter meant success | Enumerable `costBudget`/`runAllowance`; ChatEngine.checkBudgets uses limiters | `chatAutonomyLimits.test.ts` | PASS |
| F6 delegation | `0 changed` counted as mutation; mock-only process tests | `/[1-9]\d*\s+changed/`; attribution; real Windows process tree | `subagentTruthfulness.test.ts`, `processTreeTermination.test.ts` | PASS on Windows; Linux NOT RUN |

## Remaining (blocks RUN)

1. Linux descendant process-tree fixture not executed on this host.
2. Canary A (100+ tools, actual TUI/PTY, six executions) NOT RUN.
3. Canary E (crash after mutation, persistence write failure) NOT RUN as a live crash table.
4. Real-model transport canary NOT RUN (requires authorized paid inference).

UNKNOWN is encoded as omitted `ChatResult.outcome`, not a new `TerminalOutcome` member.

## Strongest case RUN is wrong

A Linux process-tree leak, a TUI-only prompt cache, or a persistence hole after
compaction could still contaminate capability attribution.
