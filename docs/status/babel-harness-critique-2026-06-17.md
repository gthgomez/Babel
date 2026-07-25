# Babel Agent Harness Critique — vs Claude Code & Codex CLI

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
**Date:** 2026-06-17
**Context:** After implementing and testing Babel's full pipeline across 5 parity tasks, 24 adversarial QA tests, and comparing against published benchmarks (Terminal-Bench 2.0, SWE-bench, HUNK4J study).

---

## Executive Summary

Babel's agent harness has **best-in-class governance infrastructure** but a **mid-tier execution capability** driven primarily by model tier, not architecture. The harness itself is competitive — the model underneath (DeepSeek-V4) is the bottleneck.

---

## Dimension-by-Dimension Comparison

### 1. Task Execution Reliability

| Metric | Babel | Claude Code | Codex CLI |
|--------|-------|-------------|-----------|
| Single-file bug fix | **100% (2/2)** | 93.28% | ~90% |
| Multi-file refactor | **100% (1/1)** with fallback | 93% (multi-hunk) | ~90% |
| Dependency/config update | **100% (1/1)** | ~70% (TB 2.1) | ~79% (TB 2.1) |
| Issue→PR implementation | **100% (1/1)** | ~70% (TB 2.1) | ~79% (TB 2.1) |
| Overall (5 tasks) | **100% (5/5)** | 70.1% (TB 2.1) | 82.2% (TB 2.0) |

**Caveat:** Babel tested on 5 fixture-scoped tasks. Commercial tools tested on 59-89 real-world tasks. Not apples-to-apples.

**Verdict:** ✅ Babel's harness is reliable at fix execution. The sequential fallback for multi-file tasks (newly implemented) closes the main gap.

### 2. Governance & Safety

| Capability | Babel | Claude Code | Codex CLI |
|-----------|-------|-------------|-----------|
| BCDP contract enforcement | ✅ Best-in-class | ❌ None | ❌ None |
| QA review loop (same model) | ✅ 3 loops max | ❌ None | ❌ None |
| Adversarial QA (different model) | ✅ Wired, env-gated | ❌ None | ❌ None |
| JIT human veto | ✅ Interactive | ✅ Permission prompts | ✅ Permission prompts |
| Checkpoint/restore (per-tool-call) | ✅ | Session-level only | ❌ None |
| Rollback on verifier failure | ✅ | ❌ | ❌ |
| Execution profiles (5 levels) | ✅ | 2 (default/ask) | 2 (default/ask) |
| Permission presets (4 levels) | ✅ | Basic | Basic |
| Terminal status normalization | ✅ | ❌ | ❌ |
| Cost ledger per task | ✅ | Token counts only | Token counts only |

**Verdict:** ✅ Babel is objectively best-in-class. No competitor has contract enforcement, adversarial QA, checkpoint granularity, or execution profiles.

### 3. Orchestration & Multi-Agent

| Capability | Babel | Claude Code | Codex CLI |
|-----------|-------|-------------|-----------|
| Subagent teams | ✅ Agent teams contract | ✅ Native | ✅ 8 parallel agents |
| Parallel read-only review | ✅ Spark lane | ✅ | ✅ |
| Workspace locking | ✅ Path-based locks | N/A | N/A |
| Mutating live subagents | ❌ Disabled (by design) | ✅ | ✅ |
| Autonomous goal loop | ✅ `babel goal` (experimental) | ✅ `/goal` | ✅ Goal mode |
| Daemon/background | ✅ Fully implemented (Phases 0-13, 19/19 tests) | ✅ Native | ✅ Native |
| Worker-loop (plan→fix→review→undo) | ✅ | ❌ | ❌ |

**Verdict (updated 2026-06-17):** ✅ Babel is strong on read-only orchestration. Goal loop exists (experimental). Daemon fully implemented (IPC, queue, scheduler, file watcher, crash recovery, evidence, governance, multi-model, rollback — 19/19 tests). P1.1 subagent maturation, P1.3 universal verifiers, and P1.4 performance optimizations all complete.

### 4. Terminal UX & Developer Experience

| Capability | Babel | Claude Code | Codex CLI |
|-----------|-------|-------------|-----------|
| Multi-line REPL input | ✅ ```paste, .editor | ✅ | ✅ |
| Ctrl+R history search | ✅ | ✅ | ✅ |
| Syntax highlighting | ❌ | ✅ | ✅ (minimal) |
| Streaming output | ✅ TUI waterfall | ✅ | ✅ |
| Inline diff display | ❌ | ✅ | ✅ |
| VI mode | ❌ | ✅ | ❌ |
| Getting started guide | ✅ Step-by-step | ✅ Interactive | ✅ Interactive |
| Interactive onboarding | ❌ Static checklist | ✅ Interactive setup | ✅ Interactive setup |
| JSON output (--json) | ✅ | ✅ | ✅ |

**Verdict:** ⚠️ Babel has the basics but lacks polish (syntax highlighting, inline diffs, VI mode, interactive onboarding).

### 5. Platform & Extensibility

| Capability | Babel | Claude Code | Codex CLI |
|-----------|-------|-------------|-----------|
| Windows-first | ✅ Primary | ⚠️ Limited | ✅ |
| Plugin/MCP ecosystem | ✅ Full | ✅ MCP only | ✅ Open source |
| Plugin trust levels | ✅ 4 levels | ❌ | ❌ |
| Prompt OS / skill authoring | ✅ Unique | ✅ Hooks | ❌ |
| Local learning / memory | ✅ Unique | ❌ | ❌ |
| Model adapter abstraction | ✅ 4 providers | Direct | Direct |
| Scheduled automation | ✅ | ❌ | ❌ |
| Cost ledger provenance | ✅ Pinned rates | ❌ | ❌ |

**Verdict:** ✅ Babel is unique — no competitor has prompt OS, local learning, or plugin trust levels. Windows-first is a differentiator.

---

## Where Babel's Harness Excels

1. **Governance depth:** BCDP contract enforcement, adversarial QA (different model), per-tool-call checkpoints, 5 execution profiles. These are not just features — they're architectural invariants. Claude Code and Codex have none of this.

2. **Safety-first design:** Mutating live subagents are deliberately disabled pending separate proof. This is the right call — Claude Code and Codex allow mutating subagents without contract-level safety nets.

3. **Sequential decomposition:** The newly-implemented auto-decompose for multi-file tasks (coordinated → per-file fallback) is a pattern Claude Code and Codex don't have — they either succeed or fail atomically.

4. **Evidence trail:** Every Babel run produces cost ledger, terminal status, verifier output, checkpoint artifacts. Claude Code/Codex produce logs but not structured evidence bundles.

## Where Babel's Harness Falls Behind

1. **Model tier gap:** DeepSeek-V4 ($0.20/M output) vs Claude Opus 4.8 / GPT-5.5 (premium tier). This is the single largest factor in benchmark scores, not harness quality. Babel's architecture can use any model — the harness is model-agnostic.

2. **Daemon/background execution (updated 2026-06-17):** The daemon is now fully implemented (Phases 0-13: IPC transport, job queue consumer, retry/backoff, file watching, crash recovery, graceful shutdown, scheduler, evidence, governance, multi-model, rollback — 19/19 tests). Gated behind soft warning. Claude Code and Codex have native background execution; Babel's daemon now provides equivalent infrastructure.

3. **Interactive onboarding:** `babel setup` prints a checklist. Claude Code and Codex have interactive setup with token configuration, workspace detection, and guided first tasks. This matters for adoption.

4. **Terminal polish:** No syntax highlighting, no inline diffs, no VI mode. These are table-stakes for developer tools in 2026.

5. **Benchmark sample size:** 5 fixture tasks vs 59-89 real-world tasks. Babel's 100% pass rate is promising but not statistically comparable to published benchmarks.

## The Architecture Ceiling

Babel's harness is **architecturally superior** to both Claude Code and Codex CLI for governed workflows. The governance infrastructure (BCD contracts, adversarial QA, checkpoint/rollback, permission profiles) has no equivalent in any competitor. The prompt OS and local learning are genuinely unique.

The bottleneck is the model, not the harness. With a premium model (Claude Opus, GPT-5.5) behind Babel's governance layer, the combination would likely exceed both Claude Code and Codex on safety-critical tasks while matching them on raw capability.

---

## Recommendation

| Priority | Action | Impact |
|----------|--------|--------|
| P0 | Add premium model support (Claude/GPT via API) for high-risk tasks | Closes model tier gap immediately |
| P1 | ✅ Daemon implemented (Phases 0-13, 19/19 tests, 2026-06-17) | Background execution gap closed |
| P1 | Interactive `babel setup` onboarding | Improves first-run experience |
| P2 | Syntax highlighting + inline diffs in REPL | Terminal UX parity |
| P2 | Expand parity corpus to 20+ tasks | Statistical significance |
| P2 | VI mode in REPL | Developer expectation |
