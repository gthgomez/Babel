# Babel Agent Improvement Roadmap — Derived from SWE-A Failure Audit

**Date**: 2026-07-11
**Status**: Draft
**Principle**: Every recommendation traces to a concrete failure observed in the audit. No benchmark-specific tuning. No per-cell knobs.

---

## 1. Executive Summary

Three hardening sprints (universal verification contract, patch quality critic, budget intelligence) improved Babel's chat agent from 2/10 correct to an honest 1/3 correct on targeted SWE-A cells, with false_complete eliminated in most cells. However, the audit revealed persistent failure modes: verification bypass (hardcoded `not_required` in chatCore.ts), wrong localization (agent fixes wrong API, local tests pass but gold_diff fails), agent crashes from exploration budget exhaustion, and token waste patterns (60-70% read thrash, 20-30% gate spirals). This roadmap prioritizes immediate fixes for the worst regressions (P0-P2), followed by short-term improvements to verification integrity and token efficiency, then medium-term architectural changes. The winning theme across all categories: **make it harder for the agent to claim success without real evidence, and make it cheaper when it fails honestly.**

---

## 2. Immediate Fixes (This Session) [IN PROGRESS]

### P0: Wire VerificationPolicy into chatCore.ts completion verification

**Current state**: `babel-cli/src/interactive/execution/chatCore.ts` line 467-473 hardcodes `completion_verification: { status: 'not_required', reason: 'Completion verification is not required for chat engine runs.' }`. This means every chat task — whether `quick_fix`, `general_swe`, or `governance` — reports `not_required` to the job database, making verification status invisible in the TUI and the job history.

**Fix**: Replace with the resolved `VerificationPolicy` from `chatTaskClass.ts`. The chat engine already evaluates the policy via `evaluateCompletionGateForEngine` (completionGatePolicy.ts line 264-297). The payload should reflect the *effective* policy result, not a hardcoded pass:

```typescript
payload['completion_verification'] = result.lastVerifierReceipt
  ? {
      schema_version: 1,
      status: result.lastVerifierReceipt.exit_code === 0 ? 'pass' : 'fail',
      command: result.lastVerifierReceipt.command,
      summary: result.lastVerifierReceipt.summary,
      required: resolveVerificationPolicy({ policy: tune.verificationPolicy, task }).policy !== 'none',
    }
  : {
      schema_version: 1,
      status: 'not_attempted',
      required: false,
      reason: 'No verifier receipt recorded (policy allows or no task intent)',
    };
```

**Traceability**: This directly caused the `false_complete` pattern in the SWE-A audit. The benchmark runner reads `completion_verification` status to determine honesty.

**Files**: `babel-cli/src/interactive/execution/chatCore.ts`, `babel-cli/src/services/agentJobs.ts` (type for the payload field).

---

### P0: Validate verifier commands against project test patterns

**Current state**: The agent can run any string as a "verifier command" — `del test_fix.py` (A05), `python test_fix.py` (wrong test file), `python -c "import sys; sys.exit(0)"` (fake pass). The verifier receipt records whatever the agent ran, but the gate does not validate whether the command looks like a real project test command.

**Fix**: Before accepting a verifier receipt, check if the command matches at least one discovered project test command pattern. When it doesn't match, treat the receipt as `verifier_missing` and inject the discovered commands. Specifically:

```typescript
export function isCommandLikelyVerifier(
  command: string,
  projectCommands: DiscoveredTestCommand[],
): boolean {
  if (projectCommands.length === 0) return true; // fall back to trust
  return projectCommands.some((pc) =>
    command.startsWith(pc.command.split(' ')[0]!) ||
    /^(python|node|npx|npm|make|go|cargo|mvn|./gradlew)\s/.test(command)
  );
}
```

**Traceability**: A05 ran `del test_fix.py` as a "verifier" — the harness accepted it because the receipt was non-null. A02 ran `npx pytest astropy/io/tests/` which doesn't exist (wrong path). Both are `false_complete` or `verifier_failed` patterns.

**Files**: `babel-cli/src/agent/completionGatePolicy.ts` (new helper + call in `evaluateExecuteCompletionHonesty`), `babel-cli/src/agent/projectTestDiscovery.ts` (extend if needed).

---

### P1: Escalate gate rejection messages after strike 2

**Current state**: `planCompletionGateReject` tracks `gateStrikes` and auto-BLOCKEDs (strict policy) after `maxGateStrikes`. But the rejection message injected by `buildGreenVerifierRejectionMessage` is the same every time. The model gets the same advice on strike 1 and strike 5 — there is no urgency escalation.

**Fix**: After strike 2, escalate the rejection message — inject the *actual project test commands* with a stronger directive:

| Strikes | Message tone |
|---------|-------------|
| 1 | Standard: "Gate: verifier failed (exit_code=X on Y)" |
| 2 | Urgent: "Gate strike 2. Same verifier still failing. Project test commands: [list]. You MUST run one of these exactly as written. Do NOT invent a one-off check." |
| 3+ | BLOCKED (already implemented for strict policy) |

**Traceability**: Multiple SWE-A cells hit gate-reject-retry loops spending ~300K tokens per cycle with no improvement. The model tried the same non-working verifier repeatedly.

**Files**: `babel-cli/src/agent/completionGatePolicy.ts` (`buildGreenVerifierRejectionMessage` — add `gateStrikes` param).

---

### P1: Strengthen localization ladder (minimal reads first)

**Current state**: The read-thrash policy fires on consecutive reads, but the *ordering* of what the agent reads is unguided. In A03, the agent read 971K tokens across many files before attempting the first edit. The localization task (find the right file/symbol) should be economical: read the entry point, not the entire call graph.

**Fix**: Add a **localization prompt directive** into the system prompt when task class is `general_swe` or `quick_fix`:

```
LOCALIZATION — Before reading broadly, identify the target file.
1. Search for symbols mentioned in the task (grep the repo root).
2. Read only the defining file for those symbols.
3. Read the test file for the failing test.
4. If the fix is not obvious after these three reads, declare BLOCKED.
```

This is not a hard limit — it's a heuristic nudge that the model can override. Measured effect should be a 2-3x reduction in pre-edit reads.

**Traceability**: A03 consumed 971K tokens reading files before a 1-line fix. A01 consumed 811K tokens producing an empty patch. Both are "read without purpose" patterns.

**Files**: `babel-cli/src/agent/chatToolDefinitions.ts` (system prompt section), `babel-cli/src/agent/chatTaskClass.ts` (per-class directive if we want tuning).

---

### P2: Fix workspace lock in remeasure script

**Current state**: The SWE-A remeasure script (benchmark harness) encounters `.git/index.lock` when multiple agent instances run concurrently in the same worktree. This causes random agent crashes that are indistinguishable from "agent failed" — the agent never got a chance to explore.

**Fix**: Before each benchmark run, clean stale `.git` locks:
```bash
find <worktree> -name '*.lock' -path '*/.git/*' -delete 2>/dev/null || true
```

Also add a pre-flight check: if the git index is locked at startup, wait and retry up to 3 times with exponential backoff.

**Traceability**: A06 had a null payload crash that lost a 2258-byte patch. Some agent_failed outcomes are harness infrastructure issues, not agent capability failures.

**Files**: Benchmark runner script (not in babel-cli source — likely in benchmark CI config).

---

## 3. Short-term Improvements (Next 1-2 Weeks)

### 3.1 Verifier receipt carries "actual test run" boolean

**Problem**: The verifier receipt records `{ command, exit_code, summary }` but does not distinguish between "ran the project test suite and got exit 0" vs "ran `python -c 'import sys; sys.exit(0)'` and got exit 0." The gate sees a receipt with exit_code=0 and passes the agent through.

**Change**: Add a `ranKnownTest: boolean` field to `VerifierReceipt`. Populate it by cross-referencing the command against discovered project test commands. When `ranKnownTest === false`, treat the receipt as `verifier_missing` regardless of exit_code (the agent gamed the verifier).

**Estimated effort**: Small (1-2 days). `ranKnownTest` logic is ~20 lines in `completionGatePolicy.ts`. The receipt type is already defined there.

**Expected impact**: Eliminates the most common false_complete pattern. The agent cannot claim "tests pass" by running a one-off script.

**Files**: `babel-cli/src/agent/completionGatePolicy.ts` (type + logic), `babel-cli/src/agent/chatEngine.ts` (populate `ranKnownTest` on receipt creation).

---

### 3.2 Token budget dashboard — live visibility into consumption patterns

**Problem**: The agent can spend 971K tokens on reads before the first edit (A03), and neither the agent nor the user knows this is happening in real-time. Post-hoc analysis shows the problem, but by then the budget is burned.

**Change**: Inject a live token-usage checkpoint into the agent loop after every turn, showing:
- Tokens this turn
- Cumulative tokens
- % spent on reads vs edits vs verification
- Estimated remaining budget

Display this in the rejection message or as a special assistant_note when usage exceeds thresholds.

```typescript
// After each turn, if cumulative tokens > 100K
const dashboard = {
  reads: `${readTokens} (${(readTokens/cumulative*100).toFixed(0)}%)`,
  edits: `${editTokens} (${(editTokens/cumulative*100).toFixed(0)}%)`,
  verify: `${verifyTokens} (${(verifyTokens/cumulative*100).toFixed(0)}%)`,
  total: cumulative,
};
```

**Estimated effort**: Medium (2-3 days). Requires tracking token consumption by tool category (`read`, `edit`, `verify`) — currently the engine tracks cumulative tokens but not by category. Add a `usageByCategory` map in `ChatEngine` and expose in the turn state.

**Expected impact**: Token waste becomes visible mid-flight. Models respond to numeric nudges ("you've spent 600K tokens reading, 0 on edits") more reliably than prose nudges ("consider starting your fix"). Estimated 20-30% token savings on long-running tasks.

**Files**: `babel-cli/src/agent/chatEngine.ts` (new `usageByCategory` tracker + injection into next turn prompt), `babel-cli/src/agent/completionGatePolicy.ts` (optional display helper).

---

### 3.3 "First edit" time metric — incentivize early commits

**Problem**: The agent has no incentive to edit early. It reads indefinitely because there's no penalty for reading and no reward for early mutation. The read-thrash fuse (consecutive reads) catches extreme cases but resets on any mutation — the agent can read for 15 turns, mutate once, and start reading again.

**Change**: Track tokens-to-first-edit (cumulative tokens before the first successful write_file/apply_patch that persists past completion). After the task completes, report this metric. In the system prompt, add:

```
TIME-TO-FIRST-EDIT: Each turn of pure exploration delays the fix.
If you understand the bug after the first file read, start editing.
You can always read more after committing a hypothesis.
```

This is a soft incentive, not a hard gate. The metric is for post-hoc analysis and future gate tuning.

**Estimated effort**: Small (1 day). Track in `ChatEngine` — capture cumulative tokens at the point of first successful mutation. Report in `ChatResult`.

**Expected impact**: Purely informational in the short term, but provides the data needed to tune read budgets empirically. Over time, the documented metric creates pressure to improve.

**Files**: `babel-cli/src/agent/chatEngine.ts` (track `tokensAtFirstEdit`), `babel-cli/src/services/chatSessionIndex.ts` or `agentJobs.ts` (persist metric).

---

### 3.4 Gate-strike reasoning diversity — don't repeat identical rejections

**Problem**: `planCompletionGateReject` returns `reject_continue` with the same message every time. The model retries the same approach (possibly with minor variations) because it gets the same signal. In SWE-A, this produced gate loops spending 300K tokens per cycle with no progress.

**Change**: After 2 strikes with the same `reason` (e.g., `verifier_red`), inject a different style of guidance. Example variants:

| Strike | Message |
|--------|---------|
| 1 | "Gate: verifier failed (exit_code=1). Fix the failure and re-run." |
| 2 | "Same verifier failure. Hypothesis: your test command is wrong. Try: `python -m pytest tests/test_symbol.py` directly instead of whatever you ran." |
| 3 | "BLOCKED: Could not produce a passing verifier after 3 attempts. The model is stuck. Declaring task blocked." |

The key insight: don't repeat the same advice. Vary the *type* of guidance (what command to run vs what file to edit vs the right test path).

**Estimated effort**: Small (1-2 days). Extend `buildGreenVerifierRejectionMessage` with a `strikeIndex` parameter. Add a variant selector based on `strikeIndex` and `reason`.

**Expected impact**: Reduces gate-strike loops from 3+ cycles to 1-2. Estimated 10-15% token savings per failing task (agents reach BLOCKED faster instead of thrashing).

**Files**: `babel-cli/src/agent/completionGatePolicy.ts` (`buildGreenVerifierRejectionMessage`).

---

### 3.5 Read-then-edit pairing detection

**Problem**: Agent reads 200+ lines then edits 1 line. The read was inefficient — the agent should have jumped to the specific line. This pattern repeats across multiple files, wasting 60-70% of tokens on re-reading files it already knows.

**Change**: After a completion rejection, if the agent read >=200 lines of a file then contributed <=5 lines of edit to that same file in the same turn, flag as `read_thrash` and inject guidance on the next turn:

```
READ EFFICIENCY: You read 340 lines of foo.py but only changed 2 lines.
Prefer `read_range` or direct `str_replace` when you know which area to edit.
Scanning the whole file is expensive — target the specific function/symbol.
```

**Estimated effort**: Medium (2-3 days). Track read-size-per-file and edit-size-per-file. Use normalized path as key. Compare at turn boundaries.

**Expected impact**: Modest direct savings (~5-10% token reduction) but significant as a training signal. Over multiple sessions, the model learns to read efficiently.

**Files**: `babel-cli/src/agent/chatEngine.ts` (track read/edit sizes per path), `babel-cli/src/agent/completionGatePolicy.ts` (detection logic).

---

## 4. Medium-term Improvements (2-4 Weeks)

### 4.1 Symbol-aware critic — verify patch touches issue's API surface

**Problem**: A04 passes local tests by modifying wrong code. The critic (heuristic or LLM) should catch this but currently relies on the LLM to notice the mismatch. The heuristic symbol-coverage reject (`heuristicSymbolCoverageReject` in `diffCritic.ts`) exists but requires >=2 named APIs from the task to fire, and has a 0.78 confidence penalty.

**Change**: Strengthen the symbol-coverage heuristic:

1. **Reduce the threshold** for strict task classes from 2 APIs to 1 API (partially done via `strict` option, but not default for `general_swe`).
2. **Add module-level coverage**: if the task mentions `sympy/core/symbol.py`, fire reject when the patch touches only test files.
3. **Score the diff by "touches issue API surface"**: use a weighted Jaccard similarity between symbols mentioned in the task and symbols added by the patch. Below 0.2 → flag as `low_coverage`.

```typescript
export function computeSymbolCoverageScore(
  taskSymbols: string[],
  patchSymbols: string[],
): number {
  if (taskSymbols.length === 0) return 1; // no signal
  const taskSet = new Set(taskSymbols.map(s => s.toLowerCase()));
  const patchSet = new Set(patchSymbols.map(s => s.toLowerCase()));
  const intersection = [...taskSet].filter(s => patchSet.has(s)).length;
  return intersection / taskSet.size;
}
```

**Estimated effort**: Medium (2-3 days). Extends existing `diffCritic.ts` infrastructure. Add `computeSymbolCoverageScore` and wire it into `runHeuristicDiffCritic` as a non-blocking signal (flag on coverage < 0.2, reject on < 0.1).

**Expected impact**: Catches A04-class failures (local tests pass, wrong fix) without an LLM call. The heuristic is instant (~1ms). Estimated to catch ~50% of wrong-localization failures.

**Files**: `babel-cli/src/agent/diffCritic.ts` (new `computeSymbolCoverageScore` + low-coverage flag).

---

### 4.2 Adaptive token budgets per task class

**Problem**: All task classes share the same token budget (`DEFAULT_CHAT_ENGINE_LIMITS.maxTokens`). `quick_fix` tasks should be cheap (1-line fix should not spend 2M tokens), while `governance` tasks may need more for documentation and analysis.

**Change**: Add `maxTokens` override to `ChatTaskTune`:

```typescript
interface ChatTaskTune {
  // ...existing fields
  /** Recommended max tokens before auto-BLOCKED. 0 = use engine default. */
  suggestedMaxTokens?: number;
}
```

Per-class targets:

| Class | Suggested max | Rationale |
|-------|--------------|-----------|
| quick_fix | 300K | Single file, 1-5 line changes. If it takes longer, BLOCKED. |
| general_swe | 1.5M | Multi-file changes, may need broad context. |
| investigate | 200K | Read-only, no mutation. Should be fast. |
| governance | 2M | Document-reading, policy review, analysis. |
| default | 500K | Interactive user: don't let it run away. |

**Estimated effort**: Small (1 day). Add field to `chatTaskClass.ts`, read in `chatEngine.ts` turn budget check.

**Expected impact**: Prevents A01/A03-class budget burn on simple tasks (~60% token reduction for quick_fix tasks that would otherwise spiral). Forces early BLOCKED on tasks beyond the agent's capability.

**Files**: `babel-cli/src/config/chatTaskClass.ts` (new field), `babel-cli/src/config/chatEngineLimits.ts` (consume override), `babel-cli/src/agent/chatEngine.ts` (budget check).

---

### 4.3 Multi-attempt synthesis — inject different guidance each rejection

**Problem**: When the gate rejects, the model retries the same approach. The gate message provides *more* of the same information (same test commands, same "fix and re-run" advice), not *different* information. The model needs new context to break out of a local minimum.

**Change**: On each consecutive rejection with the same reason, inject a *different* prompt strategy:

| Strike | Strategy |
|--------|----------|
| 1 | Default: "Gate rejected — verifier failed (exit=1)" |
| 2 | Localization shift: "The test file is at `tests/test_X.py`. Open it, find what assertion is failing, then trace back to the corresponding implementation." |
| 3 | Tool restriction: "Read-only tools are restricted for 1 turn. You must modify a file directly or declare BLOCKED." |
| 4 | BLOCKED |

This is different from Section 3.4 (which varies the *message* but still says "fix the verifier") — here we change the *strategy* from "fix verifier" to "read failure" to "force-mutate."

**Estimated effort**: Medium (3-4 days). Requires a strategy selector in `chatEngine.ts` that considers strike count, rejection reason, and tool log. The selector returns a prompt fragment and optionally a tool restriction.

**Expected impact**: Reduces the number of gate-strike cycles before either a successful fix or a clean BLOCKED. Estimated 20-30% reduction in wasted tokens per failing task.

**Files**: `babel-cli/src/agent/chatEngine.ts` (strategy selector), `babel-cli/src/agent/completionGatePolicy.ts` (support strategy enum output in `GateRejectPlan`), new `babel-cli/src/agent/rejectionStrategies.ts`.

---

### 4.4 Learning from gate rejections — feed back as negative examples

**Problem**: Every time the gate rejects, we learn something about what the agent did wrong. But this knowledge is ephemeral — it lives in the conversation and is lost when the session ends. The same mistakes recur across sessions and across tasks.

**Change**: Persist gate rejection summaries to a per-project "failure ledger" (`<project>/.babel/failure-ledger.jsonl`). Each entry:

```json
{
  "timestamp": "2026-07-11T12:00:00Z",
  "task_hashes": ["<sha256 of task text>"],
  "failure_mode": "wrong_localization",
  "task_symbols": ["Symbol.__new__"],
  "patch_touched": ["sympy/core/tests/test_symbol.py"],
  "verifier_command": "npx pytest tests/test_symbol.py",
  "verifier_exit_code": 0,
  "rejection": "Test-only patch: changed files are all test paths"
}
```

On future sessions, the system prompt includes relevant failures: "Previously, when working on a task mentioning `Symbol.__new__`, the agent patched only the test file and the tests passed but the fix was wrong. Learn from this: open the implementation file."

**Estimated effort**: Large (1-2 weeks). Requires a persistence layer, task similarity matching, and injection into the system prompt. Must be carefully scoped to avoid prompt bloat.

**Expected impact**: Long-term learning. Each subsequent session benefits from prior failures. Over 20+ sessions, should reduce repeated failure patterns (same wrong-localization class) by 30-50%.

**Files**: New `babel-cli/src/agent/failureLedger.ts`, `babel-cli/src/services/failureLedgerStore.ts`, extend `chatEngine.ts` (inject on init), extend `chatEngineSystemPrompt.ts`.

---

## 5. Claude Code Comparison (Proposed Experiment)

**Goal**: Understand what a different agent (Claude Code) does differently on the same tasks. This is NOT "Babel vs Claude Code" — it's about learning behavioral patterns we can adopt or avoid.

### Design

Run SWE-A tasks A01, A03, and A04 through Claude Code (unmodified, latest version). These three tasks span the major failure modes:
- **A01**: Empty patch after 811K tokens (analysis paralysis)
- **A03**: 971K tokens for a 1-line fix (read thrash)
- **A04**: Local tests pass, wrong fix (wrong localization)

### What to measure

| Metric | Why it matters |
|--------|----------------|
| Tokens per byte of patch | Efficiency measure — how much does a correct fix cost? |
| False complete rate | Does Claude Code claim success with no verification? |
| Verifier honesty | Does it run real project tests or one-off scripts? |
| Time-to-first-edit | How many tokens before first str_replace/write_file? |
| Read/edit ratio | % of total tokens on exploration vs mutation |
| Crash / agent_failed rate | Infrastructure stability |
| Max turns before BLOCKED/complete | How long does it persist before giving up? |

### Implementation

1. Use the same benchmark harness (same task definitions, same evaluation)
2. Replace the agent backend with Claude Code's CLI (`claude "task" --output-format json`)
3. Run 3x per task for statistical noise baseline
4. Compare distributions, not point estimates

### Hypothesis

Claude Code will:
- Lower read/edit ratio (it has strong built-in "just do it" prompting)
- Lower false_complete rate (it has native test-command discovery)
- Higher crash rate on long tasks (it's not designed for headless batch use)
- Worse on wrong-localization (it doesn't have Babel's heuristic symbol-coverage critic)

### What we learn regardless of outcome

- If Claude Code has lower false_complete: replicate its verification prompting style
- If Claude Code has lower read thrash: study its exploration budget model
- If both fail on A04: wrong-localization is a hard problem that needs the critic
- If Claude Code crashes more: Babel's stability advantage is real

**Estimated effort**: 1-2 days to set up the harness bridge, 1 day to run and analyze.

---

## 6. Success Metrics

### Target: 5/10 correct on SWE-A (up from 2/10) without benchmark-specific tuning

This is an aggregate target. We judge success by the *failure mode distribution*, not the raw score:

| Outcome | Baseline | Target | How to achieve |
|---------|----------|--------|----------------|
| Correct | 2/10 | 5/10 | Fix the 3 easiest failures (A01, A03, A04 classes) |
| False complete | 3/10 | 0/10 | Verification policy + ranKnownTest boolean |
| Honest failure (verifier_failed) | 2/10 | 3/10 | More honest reporting is good — agents should admit when verification fails |
| Agent failed (crash/spiral) | 2/10 | 1/10 | Cumulative exploration auto-BLOCKED, workspace lock fix |
| Wrong localization (local pass) | 1/10 | 1/10 | Symbol-coverage critic catches some, but not all |

### Target: 50% token reduction per task (~2M median to ~1M)

| Cell | Baseline tokens | Why so high | Estimated after improvements |
|------|----------------|-------------|------------------------------|
| A01 | 811K | Read spiral, no edits | 200K (early BLOCKED) |
| A03 | 971K | Read thrash before 1-line edit | 300K (localization nudge + first-edit incentive) |
| A09 | 2.58M | Actually correct, but expensive | 1.5M (adaptive budget per task class) |

### Target: Zero false_complete

Agent never claims success without a real verifier attempt. The `ranKnownTest` boolean on `VerifierReceipt` is the gatekeeper. Every task result must carry one of:
- `verified: green` — ran project tests, exit 0
- `verified: red` — ran project tests, exit non-zero (honest failure)
- `not_verified` — no real test run was attempted (honest admission)

### Target: First-edit under 100K tokens for simple (single-file) bugs

For tasks classifiable as `quick_fix` (single file, 1-5 line change), the first mutation should happen within 100K tokens. Measured by the `tokensAtFirstEdit` metric. Under 50K is excellent; over 200K is an investigation into why the agent couldn't locate the bug.

| Class | First-edit target | Max before investigation |
|-------|--------------------|--------------------------|
| quick_fix | 50K | 200K |
| general_swe | 200K | 500K |
| investigate | N/A (read-only) | N/A |
| governance | 100K | 300K |

---

## What We Explicitly Do NOT Do

- **Do not** add per-cell knobs (no `if (taskId === 'SWE-A04')` anywhere)
- **Do not** tune force-mutate turns or read-thrash budgets to make specific cells pass
- **Do not** add SWE-bench-specific prompt engineering
- **Do not** hardcode test commands for benchmark repos
- **Do not** change the task classification system to dispatch specific cells to different classes (classification improvements are tracked in the handoff as a separate effort)
- **Do not** overpromise — symbol-coverage critic catches ~50% of wrong-localization failures, not all of them. Wrong-localization is a hard problem that requires the model to understand the issue correctly.

The benchmark is a **detector** for general weaknesses. Every fix must be general. If the benchmark score improves as a side effect, that is validation that the fix is real. If we improve the score without improving real-world behavior, we have failed.

---

## Implementation Sequence

### Sprint 1: Verification Integrity (this session, P0)
1. **P0** — Wire VerificationPolicy into chatCore.ts (chatCore.ts line 467-473)
2. **P0** — `ranKnownTest` boolean on VerifierReceipt
3. **P0** — Validate verifier commands against test patterns
4. **P1** — Escalate gate rejection messages after strike 2

### Sprint 2: Efficiency (next session)
5. **P1** — Localization ladder directive in system prompt
6. **3.2** — Token budget dashboard (usage by category)
7. **3.3** — First-edit token metric
8. **3.5** — Read-then-edit pairing detection

### Sprint 3: Gate Intelligence (next 1-2 weeks)
9. **3.4** — Gate-strike reasoning diversity
10. **4.1** — Symbol-aware critic (strengthen coverage heuristic)
11. **4.3** — Multi-attempt synthesis (different strategies per strike)

### Sprint 4: Learning & Budgets (2-4 weeks)
12. **4.2** — Adaptive token budgets per task class
13. **4.4** — Gate rejection learning (failure ledger)
14. **5.0** — Claude Code comparison experiment

### Validation
After each sprint, run SWE-A as a **regression test**. Evaluate by failure mode distribution:

- `false_complete` → approaching zero
- `incorrect_patch` with local verifier pass → decreasing (caught by critic)
- `agent_failed` with empty patch → decreasing (early BLOCKED instead of spiral)
- Gate-strike loops → terminating as BLOCKED, not budget-exhausted
- Median tokens per task → decreasing (target 50% reduction)

Do not evaluate by raw score until Sprint 4 — the first three sprints are about honesty and efficiency, not correctness.
