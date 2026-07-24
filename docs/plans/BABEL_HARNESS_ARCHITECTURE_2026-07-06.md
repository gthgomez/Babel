# Babel Agent Harness — Architecture & Path to Claude Code Superiority

<!--
status: ACTIVE_NARRATIVE
last_verified: 2026-07-08
canonical_remaining_work: docs/audit/BABEL_CODING_AGENT_STATE_2026-07-08.md
-->
> **Status**: Active architecture narrative | **Created**: 2026-07-06  
> **Remaining work / proof status (canonical):**  
> [BABEL_CODING_AGENT_STATE_2026-07-08.md](../audit/BABEL_CODING_AGENT_STATE_2026-07-08.md)  
> Companion history: SUPERIOR_CODING_HARNESS_2026-07-06.md (vault-only),  
> babel-coding-agent-roadmap.md (vault-only).
>
> **2026-07-08 notes:** R11 text-only guard is **implemented**. Prompt caching is
> **not** “No” — provider cache hits are tracked and observed on SWE-A01. `str_replace`
> is the preferred edit tool; gate/evidence identity **fixed** (canonical T0.1 / §4 C1)
> before treating edit governance as proven. P-4 playbooks + BABEL.md **read** already exist.
>
> Grounded in the Jul 5–6 benchmark evidence: R1–R6 baseline (10/10 pass, $1.26,
> p95=1.03M tokens), the two BLOCK-01 E2E runs (tamper detection proven; text-loop
> gap found), and the v6/v7 full-manifest history.

## Part 1 — The harness as it exists today

### 1.1 Core loop (`babel-cli/src/agent/chatEngine.ts`)

A single-class agent loop with two entry points — `submitMessage` (non-streaming)
and `submitMessageStream` (streaming/CLI). Both paths now carry the same
governance machinery (this was not true before R7):

```
user input → system prompt (+ repo map + verifier command + todo list)
  → turn loop (maxTurns):
      compaction check → LLM call (native tool-calling via executeWithToolsStream)
      → tool execution (policy-gated) → observations
      → post-edit static check (tsc / node --check / py_compile)
      → verifier tamper check (R9)
      → stall state update + escalating intervention (R2/R7)
      → budget check (cost / wall-clock / tokens)
  → completion gate (evidence-validated) → payload
```

### 1.2 Capability inventory

| Layer | What Babel has | State |
|-------|----------------|-------|
| Edit primitives | `str_replace` (anchored), `write_file`, `apply_patch` | Execution + gate/evidence identity **fixed** (T0.1) |
| Read primitives | `read_file` + `read_range`, read cache with hash-based "unchanged" dedupe + `dedupe_hit_count` evidence | Wired; provider cache stronger lever than engine dedupe on PAR-B01 |
| Search | `grep`, `glob`, `semantic_search`, `list_dir` | Proven |
| Execution | `run_command` (timeouts), `test_run`, `git_context` | Proven |
| Extensions | MCP (`mcp_tool_search`, `mcp_request`) with enterprise allow-list, `web_search`, `web_fetch` | Proven |
| Sub-agents | C2 fan-out for broad localization | Exists; unproven on SWE-bench |
| Memory | LLM compaction preserving todo list, last write+diff, last verifier output, files-read hashes (L18 rung asserts survival) | Tested at unit level |
| Planning | `todo_write` injected each turn | Proven |
| Governance | Completion gate cross-checked against tool-call log; BLOCKED terminal state; verifier tamper guard with 3-tier escalation; policy allow/deny for commands and MCP | R9 proven; R7 BLOCKED live-proven GOV-B03 (T1.2) |
| Stopping | Soft budgets (cost/time/tokens); 4-level stall escalation nudge → restrict_tools → force_status → kill | Wired; text-only loops escape it (R11) |
| Autonomy | Auto-continue with context-aware prompts; isolated fixture workspaces | Proven, but restarts text loops (R11) |
| Measurement | Benchmark suite (parity + governance + SWE/HUNK/TB manifests), per-run evidence JSON, p95 token/cost tracking, `verifier_receipt`, `failure_class` taxonomy | Proven |

### 1.3 What the benchmarks say (state of the evidence)

- **R1–R6 baseline** (`benchmarks/baselines/baseline-R1-R6-2026-07-06.json`):
  10/10 runnable cells pass, $1.26 total, 2.86M tokens, p95 = 1.03M (PAR-B01).
- **BLOCK-01 Run 1**: verifier tampering detected and scored as failure — the
  governance layer caught the agent rewriting `verify.mjs`. No competing harness
  we know of does this.
- **BLOCK-01 Run 2**: the harness's biggest remaining hole — a model that stops
  calling tools entirely is invisible to the stall detector; 2.42M tokens / $1.09
  burned in pure conversation. Fix is R11.
- **SWE-A cells**: never produced a non-empty patch (v7); sub-agent fan-out unproven.
- **Cost shape**: Run 2 had 2.33M input vs 90k output tokens — history-resend
  dominates cost. Prompt caching (R5) is the single biggest cost lever left.

## Part 2 — Parity scorecard vs Claude Code

"Parity" = a user can hand Babel the same task they'd hand Claude Code and get an
equal-or-better outcome at equal-or-lower cost.

| Capability | Claude Code | Babel | Gap |
|-----------|-------------|-------|-----|
| Anchored edits (Edit/str_replace) | Yes | Yes | — |
| Ranged reads | Yes | Yes | — |
| Fast search (grep/glob) | Yes | Yes | — |
| Shell w/ timeout + backgrounding | Yes | Timeouts yes; **no backgrounding** | Add background shell + await |
| Sub-agents (Task) | Yes, validated | Exists, unvalidated | Validate on SWE-A (R10.4) |
| Todo/plan tracking | Yes | Yes | — |
| Compaction | Yes | Yes (state-preserving) | Validate under real pressure |
| Repo memory file (CLAUDE.md) | Yes | Repo map generated per session | Add persistent per-repo instruction file (see Ideas doc) |
| Hooks (pre/post tool) | Yes | Policy gates (similar role) | Expose user-configurable hooks |
| Prompt caching | Yes (Anthropic-native) | **Proven (T2.1)** — DeepSeek hit/miss tracked; PAR-B01 cost p95 $0.13 + cache hit p50/p95 ~89%/95% | Hold cost; optional read-dedupe leverage |
| Native tool calling | Yes | Yes (DeepSeek OpenAI-style) | — |
| MCP | Yes | Yes + enterprise allow-list | Babel stricter (good) |
| Slash commands / custom commands | Yes | Partial (CLI commands) | Low priority |
| **Verified completion contract** | **No — asserts "done"** | Yes: `changed_files`, `verifier_receipt`, `run_dir`, gate vs tool log | **Babel ahead** |
| **Verifier tamper detection** | **No** | Yes, proven E2E | **Babel ahead** |
| **BLOCKED honest-exit state** | **No** | **Live-proven** (GOV-B03 <100k) | **Babel ahead on honest exit** |
| **Benchmarked variance (p95)** | **No** | Yes | **Babel ahead** |
| Frontier model quality | Claude-class | DeepSeek-class | Cannot fix in harness; mitigate via scaffolding (Ideas doc) |

**Reading**: tool-surface parity is essentially achieved. The remaining parity
gaps are *economics* (prompt caching, shell backgrounding) and *proof* (sub-agents,
BLOCKED, compaction under pressure). The superiority story — governance,
verified completion, tamper detection, honest exits, variance tracking — is
already differentiated; it needs E2E proof, not more design.

## Part 3 — The plan (ordered)

### P-1. Close the loop-control hole (R11) — *prerequisite for everything*
> **2026-07-08:** Text-only counter + force_status/BLOCKED + per-round token ceiling
> are **implemented**. Full auto-continue “zero tool call refuse” is still partial
> (benchmark R12 is zero-**write**). **Proof** (BLOCK-01 BLOCKED &lt;100k) remains open
> — see [canonical T1.2](../audit/BABEL_CODING_AGENT_STATE_2026-07-08.md).

Text-only-turn counter feeding the existing escalation ladder; auto-continue
refuses to restart a round that made zero tool calls; per-round token ceiling.
**Exit criterion**: no run can spend > 200k tokens with zero tool calls.

### P-2. Validate the superiority claims E2E
1. ~~BLOCK-01 rerun → `status: BLOCKED` < 100k tokens~~ **Done** (GOV-B03 2026-07-08, T1.2).
2. Parity ×3 → real per-task p95 bands (R10.5).
3. SWE-A01 `--full` → first non-empty SWE patch via sub-agent fan-out (R10.4).

### P-3. Win the economics
1. Prompt caching (DeepSeek supports context caching) — targets the 26:1
   input:output ratio seen in Run 2.
2. Shell backgrounding + await, so long commands never eat the wall-clock budget.
3. Verifier-run dedup already wired (R8) — verify it fires with real cache hits.

### P-4. Beat Claude Code where the model is weaker
The model can't be upgraded; the harness can compensate. This is the Prompt OS
thesis — deterministic, task-aware context assembly. Concrete items live in
HARNESS_IDEAS_AND_EXPERIMENTS.md (vault-only); the
top three by expected impact:
1. **Task-class playbooks** injected by the Prompt OS resolver (bug-fix,
   test-fix, refactor, greenfield) with per-phase tool guidance.
2. **Persistent per-repo memory file** (BABEL.md) — conventions, build/test
   commands, known pitfalls — auto-updated after successful runs.
3. **Plan-then-execute enforcement** for tasks above a size threshold: a cheap
   planning turn produces a todo list before any mutation is allowed.

### Success metrics

| Metric | Now | Target |
|--------|-----|--------|
| Max tokens with 0 tool calls | 2.42M (unbounded) | ≤ 200k (hard) |
| BLOCK-01 outcome | time-budget kill | BLOCKED < 100k tok |
| SWE-A non-empty patches | **3/8 runs (37.5%)** | ≥ 3/10 |
| SWE-A correct patches | **3/8 runs, 1 scored PASS** | ≥ 1 |
| PAR-B01 cost | $0.46 | < $0.30 (caching) |
| Per-task p95 (×3 runs) | not measured | published bands |
| Cost per turn shape | linear in turns | flat-ish (81% cache hit rate on SWE-A01 pass) |
| Prompt cache hit rate | **81% (265K/325K on passing run)** | > 80% |

### SWE-A01 Passing Run (2026-07-07)

| Metric | Value |
|--------|-------|
| Status | **SUCCESS** (first SWE-bench pass in Babel history) |
| Patch | 504 bytes — `_cstack` line 245: `1` → `right` |
| Verifier | gold_diff — normalized patch comparison match |
| Tokens | 1,125,818 (1.09M in / 32K out) |
| Cost | $0.50 |
| Latency | 483s |
| Cache hit rate | 81% (265K hits / 325K total input) |
| Run evidence | `runs/agent-benchmark-live-full/archive/SWE-A01-harness-pass-*.json` |

**Enablers**: P-4 task-class playbooks (phase-gated guidance), gold-diff verifier fallback
(Windows-compatible), stall threshold tuning (`BABEL_CHAT_STALL_TURNS=20`),
verifier-as-truth scoring. 3 of 8 runs produced the correct patch; DeepSeek v4 Pro
variance is the primary limiter to pass rate.

### SWE-A01 Run History

| Run | Time | Patch | Tokens | Stall | Outcome |
|-----|------|-------|--------|-------|---------|
| 1 | 13:02 | 504B | 557K | default (15) | Correct patch, false_complete |
| 2 | 13:16 | 504B | 467K | default (15) | Correct patch, verifier_failed |
| 3 | 13:28 | empty | 236K | default + 16 maxTurns | Stall kill |
| 4 | 13:40 | empty | 247K | default + 16 maxTurns | Stall kill |
| 5 | 13:58 | empty | 334K | default (15) | Stall kill |
| 6 | 14:07 | 504B | 3.32M | 40 (no guard) | Correct patch, no stall protection |
| 7 | 14:17 | empty | 821K | 20 | Variance |
| **8** | **14:28** | **504B** | **1.13M** | **20** | **PASS ✅** |
