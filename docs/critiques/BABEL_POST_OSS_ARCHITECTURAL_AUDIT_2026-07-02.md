# Babel TUI/REPL & Coding Agent Harness — Post-OSS Remediation Implementation Roadmap

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
> **Date**: 2026-07-02
> **Supersedes**: The original post-OSS architectural audit (same file, prior revision). This document is the audit **converted into an implementation roadmap** after an independent critical review re-verified every finding against source at `babel-cli/src/`.
> **Review verdict on the original audit**: YELLOW — findings accurate and evidence-anchored; scope incomplete (monolith blind spot, no security pass, no license inventory); roadmap previously lacked dependency ordering, validation criteria, and risk notes. All of that is corrected here.
> **Branch**: the rebased fix branch (commits [commit-hash] through [commit-hash])
> **Team assumption**: 5 engineers, 4–6 weeks. Roles: TUI specialist, pipeline engineer, test-infrastructure engineer, integrations engineer, generalist/lead.

---

## Table of Contents

1. [How to Use This Document](#1-how-to-use-this-document)
2. [Corrections to the Original Audit Record](#2-corrections-to-the-original-audit-record)
3. [Dependency Graph](#3-dependency-graph)
4. [Tier 0 — Prerequisites (Week 1)](#4-tier-0--prerequisites-week-1)
5. [Tier 1 — Critical (Weeks 1–2)](#5-tier-1--critical-weeks-12)
6. [Tier 2 — Architectural Debt (Weeks 2–4)](#6-tier-2--architectural-debt-weeks-24)
7. [Tier 3 — OSS Integration Deepening (Weeks 3–5)](#7-tier-3--oss-integration-deepening-weeks-35)
8. [Tier 4 — Quality Infrastructure (Weeks 4–6)](#8-tier-4--quality-infrastructure-weeks-46)
9. [Tier 5 — Deferred / Nice to Have](#9-tier-5--deferred--nice-to-have)
10. [Cross-Cutting Gate: Architectural Budget CI Ratchet](#10-cross-cutting-gate-architectural-budget-ci-ratchet)
11. [Validation Gates per Tier](#11-validation-gates-per-tier)
12. [Appendix A: Finding Disposition Table](#12-appendix-a-finding-disposition-table)
13. [Appendix B: Evidence Index](#13-appendix-b-evidence-index)

---

## 1. How to Use This Document

- Every task carries: **ID**, **owner role**, **effort**, **dependencies**, **risk if done wrong**, and **validation criteria**.
- Tasks marked **BLOCKER** must land before their dependents start. Do not parallelize across a blocker edge.
- Effort estimates include tests. The original audit's estimates did not; several were revised upward.
- Findings are cited by their original audit IDs (D1–D6, BUG-1–6, G1–G8, P1–P6, OSS-1–5, §2.x) plus new IDs from the independent review (MF-1–MF-5). Appendix A maps every original finding to its disposition.
- **Repo invariant reminder** (from CLAUDE.md): any change to `build*Task` functions in `pipeline.ts` or to `agentContracts.ts` requires prompt-file co-evolution in the same change set. This is budgeted into the Tier 2 estimates.

---

## 2. Corrections to the Original Audit Record

The independent review re-verified ~25 file:line citations. The core findings held. The following corrections are binding for this roadmap:

| # | Original claim | Corrected record | Evidence |
|---|----------------|------------------|----------|
| C1 | `executorLoop.ts` "only imported by pipeline.ts" | Also imported by `src/testing/mockExecutorRuntime.ts` | grep verified |
| C2 | promptfoo has 6 test cases; catalog has 190 entries | **5** test cases; **189** catalog entries | `promptfoo/config.yaml`; `prompt_catalog.yaml` |
| C3 | Daemon tests contain 17 `setTimeout`s | **12** across the three named files; the 4th `Math.random` is in `queue.test.ts` (unnamed by audit) | grep verified |
| C4 | §4.4: `knowledgeGraphIndexer.ts:146` `fail()` missing error string | **False against current source** — both `fail()` calls (lines 138, 146) pass proper error strings | direct read |
| C5 | `terminalRestoreGuard.ts:181` partially mitigates BUG-3 | **No global mitigation exists** — `TerminalRestoreGuard` is instantiated only in `openEditor.ts:47`; global crash handlers route to the broken `emergencyRestore()` | grep + read verified |
| C6 | BUG-3 fix is "1 line" | 1 line + regression test + ordering decision relative to the stdout un-monkey-patch (`inputCoordinator.ts:422–429`); realistic 1–2h, merged into R1 below | direct read |
| C7 | Scorecard: "3 integration + 1 E2E" tests | **5** `*integration*` test files + 1 E2E; `chat.integration.test.ts` partially covers the chat journey | glob verified |
| C8 | Evidence appendix cites `tasks/*.output` agent transcripts | **Transcripts do not exist on disk** — provenance chain broken; see MF-5 | path check |
| C9 | §2.5: generic wrapper "eliminates all 5 repetitions" in `codeGraphBackend.ts` | `getIndexStatus` deliberately deviates (returns `'empty'` instead of throwing when stderr empty); refactor is less mechanical | direct read |
| C10 | D6 implies pipeline.ts is the cast hotspot | pipeline.ts has 2 `as any`; `ui/highlight.ts` has 18, `daemon/scheduler.ts` 7. Pipeline casts still matter (contract boundary) but the repo-wide problem is broader | grep verified |
| C11 | P5 (mentionPopup sync walk) severity MEDIUM | Downgraded to **LOW** — `maxResults=20` early-exits the recursion (`mentionPopup.ts:176`) | direct read |
| C12 | waterfall.ts listed as 2,074 lines yet line 2180 cited | Raw count 2,271; audit mixed non-blank and raw counting across files | count verified |

---

## 3. Dependency Graph

```
Tier 0 (Week 1 — prerequisites)
  R0.1  G7 dispatch routing tests ──────┬──> R2.1 Stage 2–4 extraction ──> R2.2 pipeline cast elimination
  R0.2  G1 chat-mode E2E ───────────────┘
  R0.3  MF-1 monolith re-scope ─────────────> (re-estimate all Tier 2 sizing before sprint commit)

Tier 1 (Weeks 1–2)
  R1.1  Restore-path unification (BUG-3 + MF-2) ──> R4.2 BUG-1 cursor finally (same subsystem)
  R1.2  D3 capability detection unification ──────> R1.3 D1 promptInput→OutputBuffer ──> R4.4 BUG-5

Tier 2 (Weeks 2–4)
  R2.3  G4/G5 KG test coverage            (independent)
  R2.4  OSS-1 wire-or-delete decision ────> G3 difftastic tests (only if "wire" wins)
  R2.5  OSS-2 embedding-provider decision (product) ──> OSS-2 implementation

Tiers 3–4 (Weeks 3–6)
  OSS-3, OSS-4, OSS-5, G2, G6, D2, BUG-4, MF-3, MF-4 — no blocking edges between them
```

Rules derived from the graph:

- **R0.1 and R0.2 are hard blockers for R2.1/R2.2.** Refactoring `pipeline.ts` routing-adjacent code with zero routing tests risks silently violating the CLAUDE.md chat-mode invariant ("chat mode must never invoke the v9 orchestrator").
- **R1.2 (D3) must precede R1.3 (D1).** Routing 28 writes through OutputBuffer while two detection systems disagree about DEC 2026 support would bake the contradiction deeper into the hot path.
- **R1.1, R1.3, R4.2 all touch the prompt-input/restore subsystem** — assign to one engineer (TUI specialist) to avoid merge churn.

---

## 4. Tier 0 — Prerequisites (Week 1)

### R0.1 — Dispatch routing test suite (was G7) — **BLOCKER**

- **Owner**: Pipeline engineer | **Effort**: 2–4h | **Depends on**: nothing
- **What**: New `src/interactive/execution/dispatch.test.ts` asserting the `executeTask()` routing switch: chat → `executeChatTask`, plan → `executePlanTask`, deep → `executeGovernedTask`, and `babel deep "..."` inside chat mode → `executeGovernedTask`. Include the `ambiguous_confirmation` lane and the empty-task guard.
- **Risk if wrong**: A shallow test that mocks too much validates nothing; mock at the `execute*Task` boundary only, drive through real `executeTask()`.
- **Validation**: Test fails when any routing branch in `dispatch.ts:79–99` is deliberately inverted (mutation check); CI green.

### R0.2 — Chat-mode E2E journey (was G1) — **BLOCKER**

- **Owner**: Test-infrastructure engineer | **Effort**: 4–8h | **Depends on**: nothing
- **What**: Extend from the existing `chat.integration.test.ts` (which covers `executeChatTask` directly) up to a true end-to-end path: REPL input → dispatch → ChatEngine multi-turn tool loop → rendered output. Model on `runMutationAgentLoop.e2e.test.ts`.
- **Validation**: One test exercises ≥2 chat turns with ≥1 tool call and asserts the answer reaches stdout (per the CLAUDE.md anti-pattern: "the answer must reach stdout").

### R0.3 — Monolith re-scope (MF-1, new) — **BLOCKER for Tier 2 sizing**

- **Owner**: Generalist/lead | **Effort**: 4–6h analysis | **Depends on**: nothing
- **What**: The original audit flagged `pipeline.ts` (3,407) and `executorLoop.ts` (2,911) but missed the actual largest files: `commands/coreCommands.ts` (**4,783**), `services/liveCliReliabilityMatrix.ts` (3,613), `commands/workflowCommands.ts` (3,209), `cli/structuredOutput.ts` (2,048), `services/smallFix.ts` (1,965). Produce a one-page decomposition assessment for each: is it a load-bearing monolith (like pipeline.ts) or a benign registry (command tables can be long without being risky)? Re-estimate R2.1 with this context.
- **Validation**: Written assessment reviewed by team; Tier 2 estimates re-committed or adjusted before sprint 2 starts.

---

## 5. Tier 1 — Critical (Weeks 1–2)

### R1.1 — Terminal restore-path unification (was BUG-3, expanded by MF-2)

- **Owner**: TUI specialist | **Effort**: 4–6h (was "1 line") | **Depends on**: nothing
- **What**: Three uncoordinated restore mechanisms exist, and the globally-installed one is the incomplete one:
  1. `inputCoordinator.emergencyRestore()` (`inputCoordinator.ts:399–433`) — installed on `uncaughtException`/`unhandledRejection`/SIGINT, but does **not** send `\x1b[?2026l` (DEC 2026 END). A crash mid-frame on a DEC-2026 terminal leaves all subsequent output invisibly buffered.
  2. `TerminalRestoreGuard.restoreTerminalState()` (`terminalRestoreGuard.ts:152–196`) — sends `?2026l` correctly (line 181) but is instantiated **only in `openEditor.ts:47`**; it is not a global backstop.
  3. OutputBuffer's own recovery path (`outputBuffer.ts:484–494`) — sends `?2026l` but is not wired to crash handlers.
- **Fix**: (a) add `\x1b[?2026l` to `emergencyRestore()` as a raw write, ordered **before** restoring the monkey-patched `stdout.write` (see comment at lines 407–411 for why raw writes are required there); (b) decide the long-term owner of crash-time restore — recommended: `emergencyRestore()` delegates its escape-sequence block to a shared function also used by `TerminalRestoreGuard`, so the two can't drift again.
- **Severity context** (from review): exposure is limited — `terminalCapabilities.ts:49–51` disables DEC 2026 on Windows Terminal and under tmux, and `outputBuffer.ts:205–210` AND-gates both detection systems. But when it fires, the failure is total (invisible terminal), and there is **no** global mitigation (correction C5). Keep critical.
- **Risk if wrong**: Writing `?2026l` through OutputBuffer instead of raw stdout during a crash can be swallowed by the monkey-patched write; the sequence must bypass buffering.
- **Validation**: Regression test that simulates `uncaughtException` while a sync frame is open and asserts `?2026l` reaches raw stdout; manual kill-during-render check on a DEC-2026 terminal (kitty/WezTerm/iTerm2).

### R1.2 — Unify terminal capability detection (was D3)

- **Owner**: TUI specialist | **Effort**: 4–6h | **Depends on**: nothing | **Blocks**: R1.3
- **What**: `terminalProbe.ts:122–124` says Windows Terminal supports sync update (`syncUpdate: true`); `terminalCapabilities.ts:49–51` hard-disables DEC 2026 for Windows Terminal. `outputBuffer.ts:205–210` AND-gates both, so current behavior is safe by accident. Collapse to a single source of truth (recommended: `terminalProbe.ts` absorbs the capabilities module's checks; `terminalCaps()` becomes a facade over it).
- **Risk if wrong**: Choosing the permissive answer for Windows Terminal changes runtime behavior on the platform this repo is developed on. Resolve the actual Windows Terminal DEC 2026 status (it has supported synchronized output in recent versions) with an explicit versioned decision, documented in the merged module.
- **Validation**: One module exports capability answers; `outputBuffer.ts` consults exactly one source; existing snapshot/UI tests green; grep gate: no remaining imports of the removed module.

### R1.3 — Route promptInput.ts through OutputBuffer (was D1)

- **Owner**: TUI specialist | **Effort**: 6–10h (was 4–8h; includes BUG-5 overlap analysis) | **Depends on**: R1.2
- **What**: `promptInput.ts` contains 28 direct `process.stdout.write()` calls in `render()` and cursor handling, bypassing DEC 2026 sync wrapping, a11y sanitization, and broken-pipe detection. Route through `OutputBuffer.beginFrame()`/`write()`/`endFrame()`. Emergency/recovery paths (`inputCoordinator.ts`, `terminalRestoreGuard.ts`) stay raw **by design** — document the allowlist.
- **Risk if wrong**: This is the highest-regression-risk task in the roadmap: the prompt renderer runs on every keystroke. A frame-wrapping mistake shows as input lag or cursor misplacement. Land behind a short-lived env flag (`BABEL_PROMPT_BUFFERED=0` escape hatch) removed after one week of dogfooding.
- **Validation**: grep gate — zero `process.stdout.write` in `promptInput.ts`; interactive smoke on Windows Terminal + one DEC-2026 terminal; snapshot tests green.

---

## 6. Tier 2 — Architectural Debt (Weeks 2–4)

### R2.1 — Extract shared Stage 2–4 orchestration (was §2.3)

- **Owner**: Pipeline engineer | **Effort**: 12–24h (was 8–12h; revised after review — see risk) | **Depends on**: R0.1, R0.2, R0.3
- **What**: `pipeline.ts:3178–3184` explicitly admits `resumeManualBridge` duplicates Stage 2–4 logic from `_runBabelPipelineInternal` (~230 lines; `runExecutorLoop` called identically at lines 3020 and 3374). Extract the `runStagedPipeline(manifest, evidence, options)` function the comment itself prescribes.
- **Risk if wrong**: This file carries the prompt co-evolution invariant — if extraction touches any `build*Task` function, the corresponding prompt files must move in the same change set. Also the reason the original 8–12h estimate was optimistic: `mockExecutorRuntime.ts` also imports `executorLoop` (correction C1) and test fixtures will need updating.
- **Validation**: `runExecutorLoop` called from exactly one orchestration function; `pipeline.autonomousGuards.test.ts` and `pipeline.integration.test.ts` green; the "MUST be mirrored here" comment deleted; `pwsh tools/validate-catalog.ps1` green if prompts moved.

### R2.2 — Eliminate unsafe casts in pipeline.ts (was D6)

- **Owner**: Pipeline engineer | **Effort**: 4–8h | **Depends on**: R2.1 (refactor first, then type — avoids typing code about to move)
- **What**: Replace the verified cast inventory with type guards: `as any` (901, 2163), `as unknown as Record<string, unknown>` (1507, 1672, 1798), `as unknown as QaVerdictReject` (2639), `as TargetModel` (1891, 3249), `as HaltTag` (2922, 3356). Line numbers will shift after R2.1 — re-grep, don't trust these numbers post-refactor.
- **Scope note** (correction C10): pipeline.ts is the *contract-boundary* priority, but it is not the repo cast hotspot — `ui/highlight.ts` (18 `as any`) and `daemon/scheduler.ts` (7) are ratcheted by the CI gate in §10 rather than fixed here.
- **Validation**: `rg "as any" src/pipeline.ts` returns 0; `npx tsc --noEmit` green; Zod contract tests green.

### R2.3 — Knowledge-graph test coverage (was G4/G5)

- **Owner**: Test-infrastructure engineer | **Effort**: 4–6h | **Depends on**: nothing
- **What**: `knowledgeGraphIndexer.ts` (progress parsing, concurrent-indexing guard, complete/fail registry paths) and the five `kg_*` tools have zero dedicated tests. Mock at the `handleMcpToolCall` boundary. Note correction C4: both `fail()` calls already pass proper error strings — do not "fix" that non-bug, just cover the paths.
- **Validation**: New `knowledgeGraphIndexer.test.ts` + `kgTools.test.ts`; failure paths (non-zero exit, timeout, malformed JSON) asserted; `codeGraphBackend`'s `getIndexStatus` empty-vs-throw distinction (correction C9) has an explicit test.

### R2.4 — difftastic: wire or delete (was OSS-1 + G3)

- **Owner**: Integrations engineer + lead decision | **Effort**: decision 1h; then wire 2–4h **or** delete 0.5h | **Depends on**: nothing
- **What**: `difftasticDiff.ts` (106 lines) is confirmed dead code — zero importers. The original audit assumed "wire it"; the review reframes this as a decision: deleting removes the debt equally and costs nothing. If wired (into the `apply_patch` handler or JIT diff rendering at `pipeline.ts:900`), then G3 (tests for the module) activates; if deleted, G3 is void.
- **Validation**: Either an importer exists + tests, or the file is gone. No third state.

### R2.5 — sqlite-vec embedding decision + wiring (was OSS-2)

- **Owner**: Lead (decision), integrations engineer (implementation) | **Effort**: decision spike 2–4h; implementation 6–10h | **Depends on**: decision precedes implementation
- **What**: `VectorIndex.indexEmbeddings()` is never called from production; `indexer.ts:482/501` carry explicit TODOs; the `setEmbeddingFunction` registration hook already exists (`indexer.ts:396, 933`). The blocker is a **product decision** the original audit skipped: which embedding provider, at what cost, with what offline behavior. Do not start the 6–10h implementation until that's decided.
- **Validation**: Embedding function registered at startup when configured; `SemanticIndexer.search()` blends vector results; graceful no-op when unconfigured; failure-path test (embedding API down) closes part of G8.

---

## 7. Tier 3 — OSS Integration Deepening (Weeks 3–5)

All independent; assign to integrations engineer, parallelize freely.

| ID | Task | Effort | Validation |
|----|------|--------|------------|
| R3.1 (OSS-3) | Expand promptfoo suite from **5** cases (correction C2) toward coverage of 10 domain types, ~30 skill IDs, deep governance, Android routing against the **189**-entry catalog | 4–8h | ≥1 test case per domain type; `test:prompts:ci` wired into CI |
| R3.2 (OSS-4) | Deepen nucleo-matcher: adopt `matchPatternIndexed()` (typed-array WASM path), `matchPaths` for file completion, `preferPrefix` for slash-commands; remove the post-filter in `typeaheadEngine.ts` that undermines fuzzy matching | 3–5h | fuzzyMatcher tests cover indexed mode; slash-command completion behavior test |
| R3.3 (OSS-5) | Add `babel.chat.turn`, `babel.mcp.server`, `babel.mcp.tool` span attributes. Note: `langfuseExporter.ts` is transport-only (46 lines) — attributes belong in `chatEngine.ts` and `mcpTransport.ts` span creation, not the exporter | 2–3h | Attributes visible in exported OTLP payload test |
| R3.4 (§2.4, promoted from narrative to task) | Spike: persistent MCP server processes (keep-alive stdio transport) instead of spawn-per-call with 15s timeout (`mcpTransport.ts:11, 292, 663`). Per-call spawn multiplies latency for every KG tool call — this compounds with R2.3's tools | Research spike 4–8h | Spike doc with measured per-call overhead and a go/no-go recommendation |

---

## 8. Tier 4 — Quality Infrastructure (Weeks 4–6)

| ID | Task | Owner | Effort | Validation |
|----|------|-------|--------|------------|
| R4.1 (MF-4, new) | **Security smoke pass** — the original audit had zero security findings, which is an omission, not a clean bill. 2h human pass over: config-driven MCP spawn (`config/mcp_servers.json` → `spawn`), the JIT approval flow (`pipeline.ts:891–914`), `clipboard-native.ts` (17 `execSync`/shell matches) | Lead | 2–4h | Written findings doc, even if empty |
| R4.2 (BUG-1) | Cursor-show in `finally`: `promptInput.ts` hides at 2012, shows conditionally at 2231/2233 with no `finally`; `spinner.ts` hides in `start()` (67), shows only in `stop()` (102) | TUI specialist | 1–2h | Throw-during-render test asserts `?25h` emitted |
| R4.3 (BUG-4) | Unregister event-bus listeners: `waterfall.ts` constructors register 6+ `eventBus.on` handlers (232–326, 1040–1055); `stop()` (420–433) removes resize/scheduler only — zero `eventBus.off` in file | TUI specialist | 2–3h | Instance-count test: create/stop 3 renderers, assert listener count returns to baseline |
| R4.4 (BUG-5) | Wrap streaming writes in DEC 2026 frames: `safeStdoutWrite` (`waterfall.ts:62–67`) calls `buf.write` outside frames → immediate unwrapped flush. Note it does **not** bypass broken-pipe handling (review caveat) — this is a tearing fix only | TUI specialist | 2–3h | Depends on R1.3; streaming chunks appear inside begin/end delimiters in a captured-output test |
| R4.5 (G6) | De-flake daemon tests: replace `Math.random` port selection (**12** setTimeouts, 4 randoms per correction C3; includes `queue.test.ts`) with ephemeral port binding (bind port 0, read assigned port) | Test-infra engineer | 2–3h | 20 consecutive green CI runs of the daemon suite |
| R4.6 (G2) | TUI perf regression gate in CI: FrameScheduler and OutputBuffer already record metrics; none of the 10 `package.json` benchmark scripts are referenced in any workflow (verified) | Test-infra engineer | 3–5h | CI job asserts avg render <16ms, max frame <100ms on a fixed scenario |
| R4.7 (D2) | Wire terminal focus detection to `FrameScheduler.setWindowFocused()` — currently called only from its own test file | TUI specialist | 2–3h | Focus-out doubles frame interval in an integration test |
| R4.8 (MF-3, new) | `process.exit()` audit: **127 calls in non-test source** across 20+ files (54 in `coreCommands.ts`, 31 in `workflowCommands.ts`, 6 in `inputCoordinator.ts`). Exits in CLI command leaves are acceptable; exits inside `ui/` and `services/` prevent cleanup and block E2E testability. Classify and fix the non-leaf ones | Generalist | 4–6h | Documented allowlist; zero `process.exit` in `src/services/` and `src/ui/` outside the allowlist |

---

## 9. Tier 5 — Deferred / Nice to Have

| ID | Task | Effort | Notes |
|----|------|--------|-------|
| R5.1 (P1) | Async SQLite evaluation (`DatabaseSync` blocks event loop in `ftsIndex.ts`, `tokenHistoryDb.ts`) | Research spike | Measure actual blocking time first; the "hundreds of ms" figure in the original audit was unmeasured |
| R5.2 (P4) | Governed-mode startup latency (claimed 5–15s) | Measure first | Runtime claim never measured; instrument before optimizing |
| R5.3 (§2.5) | `codeGraphBackend` generic `executeMcpWithParsing<T>()` | 2–3h | Preserve `getIndexStatus`'s empty-vs-throw deviation (correction C9) |
| R5.4 (D5) | Share `ChatMessage` type between `chatCompaction.ts:40–46` and `chatToolDefinitions.ts` | 1h | The self-containment comment is a deliberate trade-off; only do this if the canonical type changes |
| R5.5 (P5, downgraded per C11) | Event-loop yielding in `mentionPopup.ts` walk | 1–2h | `maxResults=20` already bounds the walk; low urgency |
| R5.6 (P6) | FrameScheduler scratch-buffer reuse | 2–3h | Unverified micro-optimization |
| R5.7 (P3) | Prune `toolCallLog` in ChatEngine (`chatEngine.ts:224`, grows unbounded) | 1–2h | Only matters for very long automation sessions |
| R5.8 (P2) | Sync `readFileSync` in UI render paths | audit 1–2h | Files are small today; covered by the §10 ratchet going forward |
| R5.9 (D4) | Consolidate `terminalBuffer.ts` / `outputBuffer.ts` | evaluate | Re-assess after R1.2/R1.3 land |
| R5.10 (new) | License inventory for the 10 OSS integrations — never assessed by the original audit | 1–2h | Required before any public export that bundles them |
| R5.11 (new) | Circular-import / dependency-cycle analysis — not run by the audit or the review | 1–2h | One-shot tool run; fold findings into backlog |

---

## 10. Cross-Cutting Gate: Architectural Budget CI Ratchet

**The single highest-leverage addition from the independent review.** Every fix above remediates the *stock* of debt; nothing in the original audit guarded the *flow*. Add a CI script that fails on regression against a committed baseline:

- **Max file length**: no `src/**/*.ts` file may grow past its current line count if already >2,000 lines; hard cap 2,000 for new files. (Baseline includes the MF-1 files: `coreCommands.ts` 4,783, `liveCliReliabilityMatrix.ts` 3,613, `workflowCommands.ts` 3,209.)
- **Cast ratchet**: `as any` count per file may only decrease (baseline: `highlight.ts` 18, `scheduler.ts` 7, `chatEngine.ts` 5, ...).
- **Output-path allowlist**: `process.stdout.write` in `src/ui/` only in the documented emergency-restore allowlist (from R1.1/R1.3).
- **Exit allowlist**: `process.exit` only in files allowlisted by R4.8.

**Owner**: Generalist/lead | **Effort**: 4–6h | **Do this in Week 1** — it protects every subsequent fix.

---

## 11. Validation Gates per Tier

A tier is **done** when its gate passes, not when its PRs merge:

- **Tier 0**: `dispatch.test.ts` mutation-checked; chat E2E asserts answer-on-stdout across ≥2 turns; MF-1 assessment reviewed; Tier 2 estimates re-committed. CI ratchet (§10) live.
- **Tier 1**: Kill-during-frame test validates `?2026l` on crash; single capability-detection source; zero direct stdout writes in `promptInput.ts` outside allowlist; one week of dogfooding with the escape hatch, then flag removed.
- **Tier 2**: `runExecutorLoop` has one orchestration caller; "MUST be mirrored here" comment gone; `as any` = 0 in pipeline.ts; KG failure paths tested; difftastic has zero states between wired-and-tested / deleted; embedding decision documented.
- **Tier 3**: ≥1 promptfoo case per domain type in CI; slash-command completion behavior tested; Langfuse spans carry per-turn/per-MCP attributes; MCP keep-alive spike doc delivered.
- **Tier 4**: Security findings doc exists; daemon suite 20× green; TUI perf gate in CI; exit/output allowlists enforced by the ratchet.

---

## 12. Appendix A: Finding Disposition Table

| Original ID | Verdict after review | Disposition |
|---|---|---|
| §2.1 pipeline monolith | Confirmed | R2.1 / R2.2; sizing gated on R0.3 |
| §2.2 executorLoop monolith | Confirmed (C1 correction) | Decompose as part of R2.1 follow-up |
| §2.3 admitted duplication | Confirmed | R2.1 |
| §2.4 MCP spawn-per-call | Confirmed | R3.4 spike |
| §2.5 CodeGraphBackend repetition | Confirmed with caveat (C9) | R5.3 |
| §2.6 OSS shallowness | Confirmed on all five rows (C2 counts) | R2.4, R2.5, R3.1–R3.3 |
| §2.7 chat bypasses pipeline | Confirmed | Protected by R0.1 |
| §3.1 compaction refutation | Refutation sound | No action |
| §3.2 snapshot refutation | Refutation plausible | No action |
| §3.3 BabelRepl not god class | Confirmed (~28 fields) | Optional `lastRun` grouping, unscheduled |
| §4.1 heavyweight deep mode | Reasonable | R5.2 measure-first |
| §4.2 maxTurns=8 | Confirmed | No action (env-overridable) |
| §4.3 detection contradictions | Confirmed | R1.2 |
| §4.4 registry enforcement | Partially confirmed; C4 sub-claim **false** | R2.3 covers paths; no "fix" for the non-bug |
| D1 stdout bypasses | Confirmed (28 exact) | R1.3 |
| D2 dead blur throttling | Confirmed | R4.7 |
| D3 dual detection | Confirmed | R1.2 |
| D4 dual buffers | Unverified | R5.9 |
| D5 duplicated ChatMessage | Confirmed | R5.4 |
| D6 pipeline casts | Confirmed (C10 context) | R2.2 + §10 ratchet |
| BUG-1 cursor restore | Confirmed | R4.2 |
| BUG-2 double resize render | Confirmed (stop() does clean up) | Fold into R4.3 |
| BUG-3 missing 2026l | Confirmed; mitigation claim corrected (C5, C6) | R1.1 |
| BUG-4 listener leak | Confirmed | R4.3 |
| BUG-5 unwrapped streaming | Confirmed with caveat | R4.4 |
| BUG-6 hardcoded state capture | Confirmed | Fold into R1.1 design |
| G1 no E2E | Confirmed with nuance (C7) | R0.2 |
| G2 no perf gate | Confirmed | R4.6 |
| G3 difftastic untested | Confirmed; conditional | R2.4 |
| G4/G5 KG untested | Confirmed | R2.3 |
| G6 daemon flake | Confirmed (C3 counts) | R4.5 |
| G7 dispatch untested | Confirmed; **promoted to blocker** | R0.1 |
| G8 error paths | Unverified in detail | Partially closed by R2.3/R2.5 |
| P1 sync SQLite | Mechanism confirmed; magnitude unmeasured | R5.1 |
| P2 sync render I/O | Unverified | R5.8 |
| P3 toolCallLog growth | Confirmed | R5.7 |
| P4 startup latency | Unmeasured | R5.2 |
| P5 mention walk | Confirmed; **downgraded** (C11) | R5.5 |
| P6 per-frame allocs | Unverified | R5.6 |
| OSS-1 difftastic | Confirmed dead; reframed | R2.4 wire-or-delete |
| OSS-2 sqlite-vec | Confirmed | R2.5 decision-first |
| OSS-3 promptfoo | Confirmed (5 cases / 189 entries) | R3.1 |
| OSS-4 nucleo | Confirmed | R3.2 |
| OSS-5 Langfuse | Confirmed (exporter is transport-only) | R3.3 |
| MF-1 monolith blind spot | **New — HIGH** | R0.3 + §10 |
| MF-2 no global restore backstop | **New — HIGH** | R1.1 |
| MF-3 process.exit spread | **New — MEDIUM** | R4.8 |
| MF-4 security omission | **New — MEDIUM** | R4.1 |
| MF-5 missing evidence transcripts | **New — LOW** | Regenerate `tasks/*.output` or strike the archived-evidence claim; provenance currently unverifiable |

---

## 13. Appendix B: Evidence Index

Key citations re-verified by the independent review (paths relative to `./`):

| File | Verified facts |
|------|---------------|
| `babel-cli/src/pipeline.ts` | 3,407 raw lines; 20 ` as ` cast lines; `as any` at 901/2163; duplication comment 3178–3184; `runExecutorLoop` at 3020/3374; JIT approval flow 891–914 |
| `babel-cli/src/pipeline/executorLoop.ts` | 2,911 lines; imported by `pipeline.ts` and `testing/mockExecutorRuntime.ts` |
| `babel-cli/src/commands/coreCommands.ts` | **4,783 lines** (largest file; missed by original audit); 54 `process.exit` calls |
| `babel-cli/src/ui/inputCoordinator.ts` | `emergencyRestore()` 399–433 lacks `\x1b[?2026l` (raw-byte verified); global crash handlers 377–396 |
| `babel-cli/src/ui/terminalRestoreGuard.ts` | Sends `?2026l` at 181; instantiated only in `openEditor.ts:47` |
| `babel-cli/src/ui/terminalProbe.ts` / `terminalCapabilities.ts` | winterm `syncUpdate: true` (122–124) vs `dec2026Sync: false` (49–51); AND-gated at `outputBuffer.ts:205–210` |
| `babel-cli/src/ui/promptInput.ts` | Exactly 28 `process.stdout.write` calls; cursor hide 2012, conditional show 2231/2233 |
| `babel-cli/src/ui/waterfall.ts` | 2,271 raw lines; dual resize handlers 203–206; `eventBus.on` registrations 232–326 with no `eventBus.off`; `safeStdoutWrite` 62–67 |
| `babel-cli/src/ui/frameScheduler.ts` | `setWindowFocused` (370) called only from its test file |
| `babel-cli/src/tools/mcpTransport.ts` | `MCP_TIMEOUT_MS = 15_000` (11); `spawn` at 292 and 663 |
| `babel-cli/src/services/indexer.ts` | Embedding TODOs at 482/501; `setEmbeddingFunction` at 396/933 |
| `babel-cli/src/services/knowledgeGraphIndexer.ts` | Both `fail()` calls (138, 146) pass proper error strings |
| `babel-cli/src/services/difftasticDiff.ts` | Zero importers (grep: only self-reference) |
| `babel-cli/src/services/langfuseExporter.ts` | 46 lines, transport-only; no `babel.chat.turn`/`babel.mcp.*` anywhere in `src/` |
| `babel-cli/src/agent/chatEngine.ts` | Compaction default-on (285); `toolCallLog` at 224 |
| `babel-cli/src/config/chatEngineLimits.ts` | `maxTurns: 8` (11); env override clamped [1,64] (44, 63) |
| `babel-cli/src/interactive/execution/dispatch.ts` | Routing switch 79–99; no dedicated test file |
| `babel-cli/promptfoo/config.yaml` | 5 test case descriptions |
| `prompt_catalog.yaml` | 189 `- id:` entries |
| `.github/workflows/` | Zero references to any benchmark script |
| Non-test `src/` | 127 `process.exit` calls; 6 TODO/FIXME/HACK/XXX comments total; `as any` hotspots: `highlight.ts` 18, `scheduler.ts` 7 |

> **Provenance note**: The original audit cited five agent transcripts at `tasks/*.output`; those files do not exist on disk (MF-5). Every claim in this roadmap was instead re-verified directly against source on 2026-07-02 by the independent review.
