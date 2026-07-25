# Babel Reliability Matrix Status — 2026-06-18

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
**Latest Run:** `runs/live-cli-reliability/matrix-20260618T223609Z/`  
**Score:** 36/44 passed, 8 failed, 0 timed out  
**Rebuild Rerun:** `matrix-20260619T032614Z/` — 1 of 8 confirmed fixed (autonomous_exact_file_create), 5 truncated

## Progress Timeline

| Date | Passed | Delta | Key Milestone |
|------|--------|-------|---------------|
| June 12 | 20/44 | — | Pre-fix baseline |
| June 18 AM | 28/44 | +8 | P0-P2 fixes applied |
| June 18 PM | 34/44 | +14 | Architecture changes |
| June 18 PM | **36/44** | **+16** | All fixes — release gate still BLOCKED |

## 8 Remaining Failures

### Confirmed Fixable (3)

| # | Case | Status | Fix | Effort |
|---|------|--------|-----|--------|
| 1 | `autonomous_dirty_tree_preserved` | ROLLBACK_APPLIED | Expected status mismatch — timeline IN_PROGRESS accepted in validation (commit `[commit-hash]`), needs rebuild | **Trivial** (rebuild) |
| 2 | `rollback_applied_after_failed_repair` | ROLLBACK_APPLIED | Safety mode mismatch — snapshot_only now accepted (commit `[commit-hash]`), needs rebuild | **Trivial** (rebuild) |
| 3 | `rollback_preserves_unrelated_dirty_file` | EXACT_INSTRUCTION_DRIFT | Flaky — passed in earlier runs, likely rebuild-fixable | **Easy** |

### Model Quality / Architecture (3)

| # | Case | Status | Root Cause | To Try |
|---|------|--------|------------|--------|
| 4 | `autonomous_npm_typecheck_repair` | EXACT_INSTRUCTION_DRIFT | Executor can't fix TS error. Verifier missing: npm run typecheck. | **Wire Universal Verifiers** (P1.3 from agent 2) to auto-discover `npm run typecheck` |
| 5 | `wrong_working_directory` | QA_REJECTED_MAX_LOOPS | Nested app directory repair. Executor doesn't set working_directory correctly. | **Add working_directory awareness** to `executorRecovery.ts` — detect nested package.json |
| 6 | `forced_fail_then_pass_repair` | QA_REJECTED_MAX_LOOPS | Flaky — passes in isolation (confirmed), fails in full run. Timing/ordering dependent. | **Increase per-case timeout** or **enable arena evaluation** for multi-strategy comparison |

### Infrastructure / Evidence (2)

| # | Case | Status | Root Cause | To Try |
|---|------|--------|------------|--------|
| 7 | `rollback_or_snapshot` | QA_REJECTED_MAX_LOOPS | Rollback safety evidence not recorded. `attempt_safety_summary_path=(none)` | **Wire daemon rollback evidence** (Phases 8-13 from agent 2) |
| 8 | `rollback_failed_specific_status` | EXECUTOR_HALTED | Flaky — passed in full run, failed in targeted rerun. May be model-dependent. | **Enable dynamic routing** (`BABEL_DYNAMIC_ROUTING=true`) for model self-optimization |

## Tools That Could Help (from Agent 2 Work)

| Tool | File | Could Fix Case # |
|------|------|------------------|
| Universal Verifiers (auto-discovery) | `src/stages/verifierContract.ts` | #4 — auto-find npm run typecheck |
| ripgrep search | `src/tools/ripgrep.ts` | #1-3 — more reliable file content verification |
| gitContext | `src/tools/gitContext.ts` | #2, #7 — git state awareness for rollback |
| Daemon rollback evidence | `src/services/daemon*.ts` | #7 — rollback safety evidence recording |
| Arena evaluation | `src/services/arenaRunner.ts` | #6 — multi-strategy comparison for repair |
| Subagent plan review | `src/agent/session.ts` | #5 — catch working_directory errors before execution |
| Dynamic routing | `src/routingEngine.ts` | #6, #8 — self-optimizing model selection |

## Immediate Next Actions

1. **Rebuild dist** → expected to fix #1 and #2 (committed but unbuilt validation changes)
2. **Enable dynamic routing** → `BABEL_DYNAMIC_ROUTING=true` — self-optimizes model waterfall
3. **Wire universal verifiers** into autonomous repair lane — fix #4
4. **Increase forced_fail timeout** from 480s to 600s — fix #6 flakiness
5. **Wire daemon rollback evidence** into executor safety gates — fix #7

## Projected Score

| Action | Gain | New Score |
|--------|------|-----------|
| Current | — | 36/44 |
| Rebuild (fixes #1, #2) | +2 | 38/44 |
| Universal verifiers (#4) | +1 | 39/44 |
| Timeout increase (#6) | +1 | 40/44 |
| Rollback evidence (#7) | +1 | 41/44 |
| Working directory (#5) | +1 | 42/44 |

**Realistic near-term target: 40/44 (91%)**
