<!-- License: MIT — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-07-13
purpose: Structural comparison of how Claude Code (this harness) approaches SWE tasks vs Babel's current architecture — what's holding Babel back from matching peer-CLI coding UX after L0–E fixes
-->

# Claude Code vs Babel — Structural Gap Analysis

**Date**: 2026-07-13
**Context**: Post A/B/C ship + A03 bug fixes + Tier D/E completion. F1 remeasure: 0/3 correct rate despite correct localization in all 3 cells.
**Question**: If Claude Code (this very harness) were given the same SWE-A08 task, what would it do differently, and why?

---

## 1. How Claude Code approaches a SWE task (this harness)

Claude Code is a **single-model, untrusted-tool-loop** agent. The model receives the task, decides every tool call, and owns the full sequence. There is no policy layer between the model's tool choice and execution.

### Claude Code tool set (this session)

| Tool | Role |
|------|------|
| `Read` | Read file contents (whole or range) |
| `Edit` | Exact string replacement (semantic `str_replace`) |
| `Glob` | File pattern matching |
| `Grep` | Content search (ripgrep) |
| `Bash` | Shell commands |
| `Write` | Create/overwrite files |
| `TaskCreate` / `TaskUpdate` | Structured task tracking |

### Predicted tool sequence for SWE-A08

```
Turn 1  Grep  "hist.*range.*density"         ← localize from issue keywords
Turn 2  Read  matplotlib/.../_axes.py:6350    ← read around def hist
Turn 3  Read  matplotlib/.../_axes.py:6420    ← continue reading logic
Turn 4  Edit  str_replace range/density fix   ← ONE mutation
Turn 5  Bash  pytest test_hist_range...       ← targeted verify
```

**Expected**: 5 turns, 1 write, ~$0.02–0.05 cost. Median `tools_before_first_write` = 3.

### Why this works

1. **No phase machine** — the model decides when to read vs edit. Grep → Read → Edit is a natural sequence the model already knows.
2. **No tool gating** — `Edit` is never blocked by policy. If the model thinks it understands the fix, it can edit immediately.
3. **No hard-stop** — the model can spend 2 turns or 20 turns localizing; no external policy kills the run mid-thought.
4. **No force-mutate** — the model isn't pressured to switch tools before it's ready.
5. **Single model** — no Flash/Pro split; the same reasoning engine that localizes also mutates.
6. **Thinking/reasoning** — Claude models can think before acting, producing hidden chain-of-thought that improves tool selection without consuming visible context.

---

## 2. How Babel approached the same task (observed)

### SWE-A08 (post-L0–C, cap $0.75, 40 turns)

```
Turn 1  grep   test_hist_range_and_density    ← search for test (no match — format mismatch)
Turn 2  grep   hist                            ← broad localization
Turn 3  grep   def hist                        ← narrow localization
Turn 4  read_range  _axes.py:6366              ← read def hist region
Turn 5  read_range  _axes.py:6410              ← read more
Turn 6  read_range  _axes.py:6388              ← read more
Turn 7  grep   range.*density                  ← still searching
Turn 8  read_range  _axes.py:6445              ← read more
        ── ZERO_WRITE_HARD_STOP at turn 8 ──
```

9 tool calls, 0 writes, $0.035. Agent localized correctly but never reached mutation.

### SWE-A03 (post-L0–C, worst case)

```
Turn 1–5   grep / read_range / glob               ← correct localization (qdp.py)
Turn 6     str_replace → plan-gate blocked          ← todo required
Turn 7     todo_write (2 todos)                     ← plan satisfied
Turn 8–37  str_replace ×30 → ALL phase-gate blocked ← investigate phase won't allow writes
Turn 38    Completion text → ANSWER_READY            ← false_complete
```

42 tool calls, 0 successful writes, 30 blocked `str_replace`, $0.123. Agent correctly diagnosed the fix but the phase machine created an unrecoverable deadlock. **Bug A (stallDetector counting blocked writes as successful) is now fixed** — but the architecture that made this possible remains.

---

## 3. Structural gaps — what's different

### Gap 1: Phase machine creates deadlocks (CRITICAL)

| | Claude Code | Babel |
|---|---|---|
| **Who decides tool sequence?** | Model | Phase classifier + model |
| **Can writes be blocked by policy?** | Never | Yes — phase-gate, plan-gate |
| **What happens when blocked?** | N/A | Tool call fails silently; agent may retry blindly |
| **Failure mode** | Model makes bad edit → can revert | Model CAN'T edit → thrashes or false-completes |

**The phase machine (`classifyPhase` in `chatPhaseNudge.ts`) classifies every turn into `investigate | mutate | verify | escalate`.** When phase is `investigate`, the phase tool gate (`phaseToolPolicy.ts`) blocks all mutation tools. The phase advances to `mutate` only when `turnsSinceLastWrite` passes thresholds (currently 2 for general_swe).

**The Bug A deadlock**: Before the fix, a blocked `str_replace` reset `turnsSinceLastWrite` to 0 — so the phase never advanced past `investigate`, and writes were forever blocked. After the fix, blocked writes don't reset the counter. But the underlying architecture still means:

- The agent must spend ≥2 turns reading before the phase advances to `mutate`
- During those turns, ALL mutation tools are blocked
- If the agent tries to mutate early (because it already understands the fix), it hits a phase-gate wall
- The phase-gate rejection message tells the agent "you're in investigate phase" — which the agent may interpret as "keep investigating" rather than "wait 2 more turns"

**Claude Code has no equivalent.** The model reads until it understands, then edits. There is no classifier second-guessing the model's readiness.

### Gap 2: Zero-write hard-stop is a blunt instrument (HIGH)

| | Claude Code | Babel |
|---|---|---|
| **Hard stop on no-write?** | No | Yes — 12 turns (was 8) for general_swe |
| **What happens at limit?** | N/A | Run terminates as BLOCKED |
| **Can agent recover?** | N/A | No — hard stop is terminal |

The hard-stop was designed to prevent 40-turn shell thrash (which it does successfully — A08 pre-fix burned $0.27 for nothing). But it also kills legitimate multi-turn localization. A08/A01 both localized correctly but were killed before reaching mutation.

The increase from 8→12 turns (this commit) helps, but the fundamental asymmetry remains: **Claude Code would have patched in 3–5 turns.** The question isn't whether 12 turns is enough — it's whether the agent can reach mutation in a small number of turns at all.

**Why Babel takes more turns to localize than Claude Code:**
- Babel's SWE prompt includes the full issue text, test paths, and localization hints — this is large context that the model must process before acting
- Grep results may not match because of test file format differences (A08: `test_hist_range_and_density` doesn't exist as a grep target — the actual test is in a different format)
- The agent tries multiple grep patterns before settling on reading
- Each grep consumes a turn; Claude Code can combine grep + read in a single decision

### Gap 3: Force-mutate creates mixed signals (MEDIUM)

| | Claude Code | Babel |
|---|---|---|
| **Tool restriction?** | Never | After 2 turns without writes (general_swe) |
| **What happens?** | Model always chooses tools | Tool set restricted to mutation-only |
| **Signal to model** | "You're the engineer, decide" | "Stop reading, write code NOW" |

After `forceMutateTurns` (2 for general_swe), Babel restricts the tool set to `mutate_only` — removing grep, read_file, glob, etc. The model loses the ability to read more code even if it needs to.

**This is a policy that says "I don't trust you to stop exploring"** — but the model may genuinely need one more read to confirm the fix location. Claude Code never restricts tool access; it trusts the model's judgment.

The playbook alignment (D2) mitigates this by telling the model "mutate before broad pytest," but the force-mutate policy can still fire while the model is mid-localization.

### Gap 4: Model quality / reasoning depth (MEDIUM)

| | Claude Code | Babel (DeepSeek-v4) |
|---|---|---|
| **Thinking + tools?** | Yes — reasoning before each tool call | No — thinking disabled with tool_choice |
| **Code reasoning quality** | High (trained on code) | Good, but weaker on nuanced fixes |
| **Context window** | 200K tokens | 128K tokens |
| **Instruction following** | Strong | Adequate but can drift under policy pressure |

DeepSeek-v4 through Babel correctly localized all three bugs. On A03, it correctly diagnosed the one-line fix (`re.IGNORECASE`). The problem was never "the model is too dumb to find the bug." It was **the model couldn't apply the fix because policy blocked it.**

That said, Claude Code models (Claude 4/5) have stronger code reasoning — they produce fewer false starts, use fewer turns to localize, and are less likely to grep for test names that don't exist. The thinking+tool_choice gap is real: DeepSeek can't think before every tool call, which means each tool decision is made with less deliberation.

### Gap 5: Prompt size and focus (LOW–MEDIUM)

| | Claude Code | Babel SWE harness |
|---|---|---|
| **System prompt** | ~2K tokens (focused) | Large SWE prompt + playbook + phase guidance + policy rules |
| **Task injection** | User message (clean) | Full issue text + test paths + localization ladder + pytest command |
| **Contradictory signals** | None | "Explore these files" + "Stop exploring" (force-mutate) + "Run pytest" (playbook) + "Don't shell thrash" (policy) |

Babel's SWE prompt is large and contains mixed signals. The playbook says "localize → mutate → verify." The policy says "if you haven't written in 2 turns, you're forced to mutate." The prompt says "here's the test command, run it." The phase-gate says "you can't write in investigate phase."

Claude Code's prompt is simpler: "Here's the task. You have these tools. Go." The model doesn't fight contradictory policy signals because there are none.

### Gap 6: Shell as default vs file tools as default (LOW — partially fixed)

| | Claude Code | Babel (post-D2) |
|---|---|---|
| **First tool** | Grep/Glob → Read → Edit | Grep → Read → (policy permitting) str_replace |
| **Shell role** | Support only (pytest, git) | Historically dominant; playbook now says mutate-first |
| **Edit primitives** | `Edit` (exact string replace) | `str_replace` (same semantics) |

The D2 playbook alignment moves Babel toward "mutate before env-fighting pytest." But the SWE harness still injects pytest commands into the prompt, and the model may reach for `run_command` before `str_replace` out of habit.

---

## 4. What's already fixed (credit where due)

| Gap | Fix | Status |
|-----|-----|--------|
| Shell thrash counted as progress | L0.1 — phase verify only after writes | ✅ Shipped |
| Force-mutate didn't restrict tools | L0.2 — `mutate_only` mode | ✅ Shipped |
| 40-turn zero-write burn | L0.3 — hard-stop (now 12 turns) | ✅ Shipped |
| Shell didn't count toward explore fuse | L0.4 — shell-in-fuse | ✅ Shipped |
| `toolCalls: []` on fail | L0.5 — stream failed export | ✅ Shipped |
| No policy event stream | A2 — policyEventLog | ✅ Shipped |
| Blocked attempts invisible | B3 — blockedAttemptLedger | ✅ Shipped |
| Phase-gate deadlock (Bug A) | stallDetector uses isSuccessfulDirectMutation | ✅ Fixed this commit |
| False complete after max strikes (Bug B) | completionGatePolicy hardGate → blocked | ✅ Fixed this commit |
| Playbook pushes pytest before patch | D2 — mutate-before-pytest rule | ✅ Fixed this commit |
| Hard-stop too tight (8 turns) | Increased to 12 turns | ✅ Fixed this commit |

---

## 5. What's still holding Babel back

Ordered by impact on "would it have patched A08?"

### 5.1 The phase-gate itself (architectural)

Even with Bug A fixed, the phase-gate still blocks writes during `investigate` phase. The agent must spend ≥2 turns reading before the phase advances to `mutate`. For `general_swe`, `phaseGatedToolsDefault: true` means this gate is always active.

**Claude Code equivalent**: There is none. The model edits when ready.

**Fix options**:
- **A (conservative)**: Reduce `forceMutateTurns` to 1 and `turnsSinceLastWrite` escalate threshold to 1 — phase advances faster
- **B (moderate)**: Disable `phaseGatedToolsDefault` for `general_swe` (set to `false`, matching `default`/`quick_fix`) — trust the model to sequence its own tools on hard SWE
- **C (radical)**: Remove the phase tool gate entirely — let the model call any tool at any time, observe what breaks

**Recommendation**: Option B. The phase-gate was designed to prevent premature writes, but on SWE tasks the model's judgment is better than the classifier's. `default` and `quick_fix` already run without phase-gated tools — `general_swe` should too. Keep phase classification for model routing (Flash vs Pro) and observability (routing receipts), but stop using it to block tool access.

### 5.2 The hard-stop as safety net

The hard-stop still fires at 12 turns. A08 needed ≥4 turns just to localize. If the agent takes 6 turns localizing (grep×3, read×3) and then needs 2 turns for mutation (str_replace, maybe another str_replace), that's 8 turns. If it takes 10 turns localizing, the hard-stop kills it before mutation.

**Claude Code equivalent**: Claude Code would patch in 3–5 turns, but Babel's model needs more turns because of weaker code reasoning + larger prompt + grep misses.

**Fix options**:
- **A**: Increase to 16 turns for general_swe
- **B**: Make hard-stop a soft nudge (warn, don't kill) for the first violation
- **C**: Tie hard-stop to tool diversity (reset if model is reading different files, not thrashing on same file)

**Recommendation**: Option C (longer-term). For now, monitor the next smoke at 12 turns. If the agent still gets hard-stopped before mutation, increase to 16.

### 5.3 Model reasoning gap

DeepSeek-v4 cannot use thinking+tool_choice together. This means every tool call is made without hidden chain-of-thought deliberation. Claude models think before every tool call — the reasoning step helps avoid false starts (grep for wrong test name, read the wrong region).

**Claude Code equivalent**: This is the one area where model capability genuinely differs. Claude models' reasoning before tool calls reduces localization turns and improves first-tool accuracy.

**Fix options**:
- **A**: Prepend a no-tools planning turn (Flash model, text-only) before the tool loop — B1 optional thoughts capture already has the infrastructure
- **B**: Use a different provider that supports thinking+tools (if available at comparable cost)
- **C**: Accept the gap — localization is correct, just slower

**Recommendation**: Option A. The B1 thought capture infrastructure already exists. A single planning turn before the tool loop ("Read the task, identify the likely fix location and strategy, then begin") would cost one Flash call (~$0.001) and could reduce localization turns by 30–50%.

### 5.4 Prompt contradiction (RC9 residual)

The SWE prompt still contains: issue text, test paths, localization hints, pytest commands, playbook guidance, phase policy rules, and task-class parameters. These signals sometimes conflict:
- "Run the test to see it fail" (prompt) vs "Don't shell thrash" (policy)
- "Explore the codebase" (prompt) vs "Mutate NOW" (force-mutate at turn 2)
- "You're in investigate phase" (phase-gate) vs "Use str_replace" (playbook)

**Claude Code equivalent**: The task description is clean. No policy layer adds contradictory instructions.

**Fix options**:
- **A**: Trim the SWE prompt — remove pytest command injection, keep localization hints only
- **B**: Remove force-mutate and phase-gate language from system prompt when those features are active (let policy act silently)
- **C**: Full prompt audit for contradictory signals

**Recommendation**: Options A+B. The playbook already says "mutate before pytest." Stop injecting the pytest command into the prompt. Let policy act without announcing itself in the system message.

---

## 6. What execution would look like after applying Gap 5.1 + 5.3

### Predicted Babel tool sequence for A08 (with phase-gate OFF + planning turn)

```
Turn 0  [Planning turn — Flash, text-only]
        → "Bug: hist() ignores range= when density=True.
           Fix location: _axes.py def hist(), around line 6366.
           Strategy: read the density/range logic, one str_replace."
Turn 1  Grep  "def hist"                       ← targeted, not test-grep
Turn 2  Read  _axes.py:6366-6450               ← read relevant region
Turn 3  Edit  str_replace (fix density check)  ← ONE mutation
Turn 4  Bash  pytest lib/matplotlib/tests/test_axes.py -k test_hist -x
Turn 5  Completion — patch or honest BLOCKED
```

**5 turns, 1 write, $0.03–0.05.** Matches Claude Code-class process.

### What changes

| Metric | Current (post-fix, pre-Gap5) | With phase-gate OFF + planning turn |
|--------|------------------------------|-------------------------------------|
| `tools_before_first_write` | 9 (never wrote) | ≤4 |
| Hard-stop risk | Moderate (12 turns for 9+ reads) | Low (5 turns total) |
| Phase-gate blocks | None in this run, but latent risk | None — gate removed |
| Correct rate (predicted) | 0/3 (all blocked before mutation) | 1–2/3 (A08 and A01 likely patch) |

---

## 7. Summary — what matters most

| Rank | Gap | Impact | Fix complexity |
|------|-----|--------|----------------|
| **#1** | Phase-gate blocks writes on SWE | A03: 30 blocked str_replace → false_complete | **1 line**: `phaseGatedToolsDefault: false` for general_swe |
| **#2** | No planning turn before tool loop | 2–3 extra grep turns per cell | **1 feature flag**: prepend Flash planning turn |
| **#3** | Prompt contradiction (RC9) | Model fights mixed signals | **Edit playbook**: remove pytest injection from SWE prompt |
| **#4** | Hard-stop calibration | Killed A08/A01 at turn 8 (now 12) | Already done; monitor next smoke |
| **#5** | Force-mutate tool restriction | Model loses read access when pressured | **Soft nudge instead**: message, don't restrict |
| **#6** | Model reasoning depth | 3–4 grep turns vs 1–2 for Claude models | Planning turn helps; provider upgrade later |

---

## 8. Immediate recommended actions

1. **Set `phaseGatedToolsDefault: false` for `general_swe`** — one line, highest impact. The phase classifier still runs for routing receipts + model selection, but it no longer blocks tool access. Trust the model to sequence its own tools on hard SWE tasks.

2. **Add a planning turn** — prepend one Flash text-only turn before the tool loop for `general_swe`. Costs ~$0.001 per run, reduces localization turns. Uses existing B1 infrastructure.

3. **Re-smoke A08 + A01** with both changes. If either patches, the gap analysis is validated.

4. **Defer** force-mutate change and full prompt audit until the phase-gate + planning turn changes have been validated.

---

## 9. Related documents

- Babel vs Grok CLI Gap & Fix Plan — original diagnosis
- [Peer-CLI Parity Next Roadmap](../plans/BABEL_PEER_CLI_PARITY_NEXT_ROADMAP_2026-07-13.md) — current execution
- A03 False Complete Root Cause — Bug A/B details
- Selective Remeasure Post-E — F1 evidence
