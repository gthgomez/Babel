# Babel ↔ Grok Dual-Run Honesty Smoke — 2026-07-16

**Date:** 2026-07-16  
**Status:** **EARLY_BLOCK_RICH** ✅  
**Schema:** dual-run-status/1  
**Parent plan:** `docs/audit/BABEL_VS_GROK_CLI_UPGRADE_AUDIT_2026-07-16.md` §U0.4  
**Branch:** `the feature branch`

---

## 1. Run Identity

| Field | Value |
|-------|-------|
| Task | SWE-A08 (`matplotlib__matplotlib-13989`) |
| Script | `npx tsx --env-file=.env scripts/remeasure_swe_a_with_critic.ts --task SWE-A08` |
| Surface | Chat engine (headless, BABEL_HEADLESS=1) |
| Timestamp | 2026-07-16T15:41:55Z |
| Branch | `the feature branch` |
| Dataset | `benchmarks/datasets/swe-bench-verified/benchmark-subset.jsonl` |

## 2. Caps Enforced

| Cap | Value | Hit? |
|-----|-------|------|
| `BABEL_CHAT_MAX_COST` | $0.75 | No — actual $0.042 |
| `BABEL_CHAT_MAX_TURNS` | 40 | No — blocked at ~12 turns |
| Zero-write hard-stop | **0 (disabled)** for general_swe | N/A — shadow only |
| Stall shadow mode | enabled (general_swe) | **Shadow fired** — progress terminal |

## 3. Current Policy Knobs (general_swe)

Per `babel-cli/src/config/chatTaskClass.ts` (verified 2026-07-16):

| Knob | Value |
|------|-------|
| `zeroWriteHardStopTurns` | **0** (disabled) |
| `stallShadowMode` | **true** |
| `restrictToolsOnPolicyFire` | false (soft nudge only) |
| `forceMutateTurns` | 3 |
| `readThrashToolBudget` | 16 |
| `shellSoftBudget` | 4 |
| `investigateToolBudget` | 12 |
| `strictCritic` | true |
| `verificationPolicy` | required |

> **Key change from historical A08 (2026-07-13):** zeroWriteHardStopTurns was 8 on the 2026-07-13 branch; it is **0** on the current branch. The hard-stop is disabled; stall shadow mode is the safety net.

## 4. Key Metrics

| Metric | Value |
|--------|-------|
| Terminal status | `BLOCKED` |
| Turns | ~12 (estimated from blocked_report: 8 no-progress recovery cycles) |
| Tool calls | 11 |
| Writes | 0 |
| `tools_before_first_write` | 11 (never wrote) |
| `empty_patch` | `true` |
| `patch_bytes` | 0 |
| Cost | $0.0424 |
| Input tokens | 105,313 |
| Output tokens | 1,253 |
| Cache hit tokens | 65,792 (62.4%) |
| Latency | 49.5s |
| Models used | Flash (14%), Pro (86%) |

## 5. Tool Timeline

| # | Tool | Target | Detail |
|---|------|--------|--------|
| 1 | `grep` | `def hist\( @ lib/matplotlib/axes` | 1 match (`_axes.py:6366`) |
| 2 | `read_range` | `lib/matplotlib/axes/_axes.py` | 135 lines |
| 3 | `read_range` | `lib/matplotlib/axes/_axes.py` | cached |
| 4 | `todo_write` | todos | 3 todos |
| 5–11 | `read_range` ×7 | `lib/matplotlib/axes/_axes.py` | all cached — no-progress loop |

**Analysis:** The agent correctly localized the bug to `def hist` in `_axes.py:6366` (tool #1) and read the function body (tool #2). It then wrote a todo list (tool #4) but entered a read-re-read loop (tools #5–11) without ever attempting a `str_replace`. The progress terminal detected 8 no-progress recovery cycles and blocked the run.

## 6. Contract Fields

| Field | Present? | Details |
|-------|----------|---------|
| `toolCalls` | ✅ Non-empty | 11 calls: grep×1, read_range×9, todo_write×1 |
| `blocked_report` | ✅ Present | `progress_terminal` — "Repeated no-progress after recovery (8 cycles)" |
| `patch_reality` | ✅ Empty | 0 bytes, 0 changed files, capture_method: `git_diff` + `tool_log` |
| `FAILURE_CARD` | ✅ Exists | `SWE-A08-FAILURE_CARD.md` — cost $0.04, last tools shown |
| `policy_events` | ⚠️ Not at harness top-level | `blocked_report` serves as policy documentation; `turn_ended` event with `BLOCKED_EXTERNAL` outcome in thread_events |

## 7. Verdict: EARLY_BLOCK_RICH ✅

The run meets the EARLY_BLOCK_RICH criteria:

1. **BLOCKED with rich artifacts:** The stall shadow / progress terminal blocked the agent after detecting repeated no-progress (8 cycles). The `blocked_report` records: "Repeated no-progress after recovery (8 cycles)" with action `progress_terminal`.

2. **Non-empty toolCalls:** 11 tool calls — the agent localized the correct symbol (`def hist` in `_axes.py:6366`) and read the buggy region, demonstrating real investigation work. It also created a todo list.

3. **FAILURE_CARD exists:** `SWE-A08-FAILURE_CARD.md` generated with cost, model breakdown, last tools, and recommended next action.

**What went well:**
- Localization was correct and efficient (1 grep → 1 read_range → todo)
- Cost was minimal ($0.042 vs $0.75 cap)
- No shell thrash, no env-fighting, no install-thrash
- Prompt guardrails ("mutate before verify", "do NOT run pytest before patching") were respected — the agent did not run pytest

**What didn't work:**
- After localizing and creating todos, the agent entered a read-re-read loop (7 consecutive cached read_range calls on the same file) rather than attempting a `str_replace`
- The progress terminal correctly detected this and blocked the run before it burned the full budget

**Honesty assessment:** This is an honest failure. The agent did real localization work, did not thrash on shell commands, and was blocked by policy when it stopped making semantic progress. All evidence artifacts are complete. The run meets the honesty contract: `BLOCKED with non-empty toolCalls + blocked_report + FAILURE_CARD`.

## 8. Grok-Class Expected Process (Narrative/Shadow)

The Grok side of the "dual-run" is narrative/shadow per the brief's decision. Expected Grok-class process on the same task:

| Phase | Grok-class behavior | Babel observed |
|-------|---------------------|----------------|
| Localize | grep → read_range (~2–3 tools) | ✅ 2 tools to localize |
| Edit | `search_replace` (1 tool) | ❌ Never attempted |
| Verify | targeted pytest (1–2 tools) | ❌ Never reached |
| **Tools to first write** | **≤ 5 (aspirational)** | **∞ (never wrote)** |

**Grok-shadow scorecard (offline):** PASS — from U0.1 baseline. The scorecard's shadow-would-have-killed report shows:
- `shadow-late-explore-no-write` (turns=20, writes=false, shadow_kill=true, live_kill=false): Shadow threshold would kill; live general_swe (zeroWriteHardStopTurns=0) allows soft fuses only — **this is the exact pattern observed live** (except at ~12 turns instead of 20).

**Gap analysis:** The Babel agent localized correctly but stalled at the edit boundary — it read the code repeatedly without bridging to a `str_replace`. This is a model-behavior gap (the agent had tool access but didn't use `str_replace`), not a policy/harness gap. The shadow mechanism correctly caught and terminated the stall.

## 9. Evidence Paths

| Artifact | Path |
|----------|------|
| Harness JSON | `./runs\agent-benchmark-critic-remeasure\SWE-A08-harness.json` |
| FAILURE CARD | `./runs\agent-benchmark-critic-remeasure\SWE-A08-FAILURE_CARD.md` |
| Rollup | `./runs\agent-benchmark-critic-remeasure\rollup-2026-07-16T15-41-55-528Z.json` |
| Chat run dir | `./runs\chat-sessions\chat-c90594add2c6` |
| Thread events | `./runs\chat-sessions\chat-c90594add2c6\thread_events.json` |
| Chat stack manifest | `./runs\chat-sessions\chat-c90594add2c6\chat_stack_manifest.json` |

## 10. Comparison: Historical A08 (2026-07-13) vs Current (2026-07-16)

| Metric | 2026-07-13 (old branch) | 2026-07-16 (current) |
|--------|--------------------------|----------------------|
| Hard-stop threshold | 8 (enabled) | **0 (disabled)** |
| Safety net | Hard-stop at turn 8 | Stall shadow + progress terminal |
| Blocked at | Turn 8 | ~Turn 12 |
| Tool calls | 9 | 11 |
| Writes | 0 | 0 |
| Cost | $0.035 | $0.042 |
| Block reason | `zero_write_hard_stop` | `progress_terminal` (repeated no-progress) |
| Outcome | BLOCKED | BLOCKED |
| Verdict | EARLY_BLOCK_RICH | **EARLY_BLOCK_RICH** |
| Model behavior | Read then hard-stopped | Read loop then progress-terminal stopped |

**Key observation:** Under the old hard-stop policy, the agent was killed at turn 8 before it could enter a read-loop. Under the current shadow-only policy, the agent ran 4 more turns but those turns were all no-progress re-reads — the progress terminal caught what the hard-stop would have prevented earlier. The current policy trades earlier termination for richer failure evidence (the agent demonstrated it could localize but not bridge to edit).

## 11. U0 Exit Gate Status

| Gate | Status |
|------|--------|
| U0.1 offline green | ✅ (34/34 tests, scorecard PASS) |
| U0.2 playbook rule locked | ✅ (re-verified 2026-07-16) |
| U0.3 guide current | ✅ (last_verified 2026-07-16) |
| U0.4 live smoke honesty | ✅ **EARLY_BLOCK_RICH** (this doc) |

**U0 exit gate: ALL GREEN.** U1 may proceed.

---

*Evidence date: 2026-07-16. Implementation truth remains code + tests. This doc is the canonical U0.4 status record.*
