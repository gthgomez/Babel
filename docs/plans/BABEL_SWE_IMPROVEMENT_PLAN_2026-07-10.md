# Babel General-Purpose Improvement Plan — Derived from SWE Benchmark Evidence

**Date**: 2026-07-10
**Status**: Draft
**Principle**: Fix the *behaviors* the benchmark exposed, not the benchmark scores. Every change must improve Babel for any repo, any task.

---

## Evidence → Capability Mapping

SWE-A failures are symptoms of general agent weaknesses. The same failures happen in any repo:

| SWE Symptom | General Weakness | Real-World Impact |
|-------------|-----------------|-------------------|
| A03/A05/A10: claimed success with failing tests | Agent doesn't verify its work honestly | User trusts a broken "fix" |
| A04: local tests pass but fix is wrong | Agent fixes symptoms, not root cause | Wrong PR merged, regression later |
| A01: 811K tokens, empty patch | Agent explores endlessly without committing | User waits 5 min for nothing |
| A06: null payload crash, 2258B patch lost | Harness drops work on process crash | User rage-quits after lost work |
| A02: ran wrong test, exit_code=4 | Agent doesn't know the project's test harness | Useless verification, fake confidence |
| Gate reject → retry → reject → retry | Gate loop burns budget without helping model improve | "I'm stuck" loop with no escape hatch |

None of these are specific to astropy, sympy, matplotlib, or pylint. They're universal.

---

## Improvement Plan

### Phase 1: Verification Integrity (high-impact, low-risk)

#### 1A. Universal verification expectation — remove the `default: requireGreenVerifier=false` gap

**Current state**: `default` task class has `requireGreenVerifier: false`. An interactive user asking "fix the login bug" gets no verification gate. The agent can claim ANSWER_READY with zero evidence.

**Change**: Introduce a `verificationPolicy` enum replacing the boolean `requireGreenVerifier`:

```typescript
type VerificationPolicy = 'none' | 'required' | 'strict';

// Per task class:
// investigate    → 'none'     (read-only, no verification expected)
// default        → 'required'  (must have verifier receipt, any exit code accepted — show user)
// quick_fix      → 'required'  (must have verifier receipt, non-zero warns but allows)
// general_swe    → 'strict'    (must have exit_code=0, never soft-allow)
// governance     → 'strict'    (must have exit_code=0, never soft-allow)
```

**Why it's general**: A user fixing a bug in any repo sees "⚠ Complete — tests failed (exit 1)" instead of just "✓ Complete." They know to check the agent's work. The agent also knows it must at least TRY to verify.

**Files**: `chatTaskClass.ts` (new field), `completionGatePolicy.ts` (use policy not boolean), `chatEngine.ts` (updated gate flow), tests.

#### 1B. TUI: Show verification status in completion display

**Current state**: The TUI shows tool completions inline but the final "Complete" message doesn't distinguish between "verified with passing tests" and "claimed done with no evidence."

**Change**: The conversational renderer's completion path should emit:

```
✓ Complete — 3/3 tests passing  ·  $0.42  ·  2m 18s
⚠ Complete — verification failed (exit 1)  ·  $0.42  ·  2m 18s  
✗ No verification run  ·  $0.42  ·  2m 18s
```

This requires the `ChatResult` to carry `verifierReceipt` (it already does!) and the TUI to render it. The plumbing exists — `terminalResultFromDoneEvent` already passes `verifierReceipt`. The TUI just doesn't display it prominently.

**Why it's general**: Every user of Babel in any repo immediately knows whether the agent's work was verified. This builds trust calibration — the user knows when to double-check.

**Files**: `waterfall.ts` (completion rendering), `chatEventDispatch.ts` (pass-through), tests.

#### 1C. Project test-command discovery

**Current state**: When the gate rejects with "verifier failed," the message says "run the project verifier" but doesn't tell the agent HOW. The agent guesses wrong (e.g., `del test_fix.py` for A05).

**Change**: On session start, discover the project's test commands:
- Check `package.json` scripts.test
- Check for `pytest`, `make test`, `cargo test`, `go test`
- Store as `projectTestCommands: string[]`

In the gate rejection message, include the discovered commands:
```
Gate: verifier failed (exit_code=1 on "del test_fix.py").
Project test commands: npm test, npx jest, python -m pytest
Run one of these until exit 0 before completing.
```

**Why it's general**: Any repo has its own test harness. The agent should know what it is. This is like a human engineer reading the README before contributing.

**Files**: New `projectTestDiscovery.ts` helper, `completionGatePolicy.ts` (inject commands into message), `chatEngine.ts` (discover on init).

### Phase 2: Patch Quality (medium-impact, medium-risk)

#### 2A. Symbol-coverage check in verifier

**Current state**: The verifier only checks exit_code. A04 validates this is insufficient — the agent can make tests pass by modifying the wrong code.

**Change**: Before accepting a verifier pass, check that the patch touches symbols/APIs mentioned in the task description:
- Extract identifiers from the task (backtick-quoted names, `module.Class`, function references)
- Check if the patch modifies files containing those identifiers
- Flag as `low_coverage` if none match

This is a heuristic signal, not a hard gate. The critic already runs before completion — add symbol coverage as a critic dimension:
```
Critic dimension: localization
- Task mentions: Symbol.__new__, core.symbol
- Patch touches: sympy/core/tests/test_symbol.py
- Verdict: REJECT — patch only touches test file, not the implementation
```

**Why it's general**: Any bug report mentions specific APIs. A fix that doesn't touch those APIs is suspicious, regardless of repo.

**Files**: `diffCritic.ts` (new localization dimension), `diffCritic.test.ts`, possibly new `symbolExtraction.ts` helper.

#### 2B. Patch-diff preview in TUI before completion

**Current state**: The TUI shows individual tool calls (write_file, apply_patch) but doesn't summarize the total diff at completion. The user has to scroll back through tool output.

**Change**: When the agent reaches ANSWER_READY, the TUI shows a compact diff summary:
```
── Changes ──
 src/auth/login.ts         +12  -3
 src/auth/session.ts       +5   -1
 tests/auth/login.test.ts  +24  -0
── Verification ──
 npm test: exit 0, 47/47 passing
── Complete · $0.42 · 2m 18s
```

**Why it's general**: Every developer wants to see "what changed" before accepting an AI's work. This builds trust and catches obvious errors (e.g., "why did it touch that file?").

**Files**: `waterfall.ts` (completion rendering), `chatEngine.ts` (track changed files).

### Phase 3: Budget Intelligence (lower-impact, quality-of-life)

#### 3A. Progressive exploration budget with escalation

**Current state**: The read-thrash fuse counts consecutive read-only tools. Reset on any mutation. But A01 shows the model can read 811K tokens across many different files without ever mutating — the fuse resets or doesn't trigger because reads are interspersed with non-mutation tools.

**Change**: Add a **total exploration token counter** that doesn't reset:
- Track cumulative tokens spent on read/list/search/grep/glob tools
- At 50% of wall budget with no writes: inject a nudge
- At 75%: escalate — "You've spent X tokens exploring. You must either commit to a fix path within 2 turns or declare BLOCKED."
- At 90%: auto-BLOCKED — "Exploration budget exhausted without any file changes."

This is a safety net, not a primary mechanism. The force-mutate fuse still fires earlier for quick_fix tasks.

**Why it's general**: Any complex task in any repo can trigger analysis paralysis. A safety net that says "you've read enough, act or admit you're stuck" improves the experience for everyone.

**Files**: New `explorationBudget.ts` helper, `chatEngine.ts` (track and check), `chatTaskClass.ts` (per-class exploration budget).

#### 3B. Crash-safe patch persistence

**Current state**: A06 had a 2258-byte patch generated but the CLI process crashed before serialization. The work was lost.

**Change**: After every successful `write_file` or `apply_patch`, append the patch to a recovery file (`<runDir>/patches.log`). If the CLI crashes, the patch survives and can be recovered on next session or displayed in the error message.

**Why it's general**: Crashes happen. Losing 22 minutes of work is unacceptable in any context.

**Files**: `chatEngine.ts` (write-through on mutation), error recovery path in `chat.ts`.

#### 3C. Auto-declare BLOCKED when gate-strike loop detected

**Current state**: For `requireGreen` tasks, `planCompletionGateReject` always returns `reject_continue` regardless of strike count. The model loops: complete → gate rejects → retry → complete → gate rejects → ... until max turns. Each loop costs tokens with no progress.

**Change**: After MAX_GATE_STRIKES consecutive rejections with no new verifier attempt, auto-declare BLOCKED with a specific reason: "Could not produce a passing verifier after N attempts." This prevents the budget-burn spiral.

**Why it's general**: An agent stuck in a "try the same thing" loop wastes the user's time and money. Better to fail fast with a clear reason.

**Files**: `completionGatePolicy.ts` (add BLOCKED path after max strikes), `chatEngine.ts` (handle new plan kind).

---

## What We Explicitly Do NOT Do

- **Do not** add per-cell knobs (no `if (taskId === 'SWE-A04')` anywhere)
- **Do not** tune `forceMutateTurns` or `readThrashToolBudget` to make specific cells pass
- **Do not** add SWE-bench-specific prompt engineering
- **Do not** hardcode test commands for benchmark repos
- **Do not** change `classifyChatTaskClassFromText` to detect "EXPLORE: LOCALIZATION LADDER" as `general_swe` (the benchmark harness should set the class explicitly)

The benchmark is a **detector** for general weaknesses. The fix must be general. If the benchmark score improves as a side effect, that's validation that the fix is real. If we improve the score without improving real-world behavior, we've failed.

---

## Implementation Sequence

### Sprint 1: Verification Integrity (highest ROI)
1. **1A** — Universal verification policy (removes the `default: false` gap)
2. **1B** — TUI verification display (user sees what happened)
3. **1C** — Project test-command discovery (agent knows HOW to verify)

### Sprint 2: Patch Quality
4. **2A** — Symbol-coverage critic dimension (catches A04-class failures)
5. **2B** — TUI diff preview (user sees what changed)

### Sprint 3: Budget & Reliability
6. **3A** — Progressive exploration budget (catches A01-class failures)
7. **3B** — Crash-safe patch persistence (recovers A06-class crashes)
8. **3C** — Gate-strike auto-BLOCKED (prevents budget-burn spirals)

### Validation
After each sprint: run SWE-A benchmark as a **regression test**. The score should improve, but we judge success by the *failure mode distribution*, not the raw score. Specifically:
- `false_complete` should approach zero
- `incorrect_patch` with local verifier pass should decrease
- `agent_failed` with empty patch should decrease
- Gate-strike loops should terminate as BLOCKED, not budget-exhausted
