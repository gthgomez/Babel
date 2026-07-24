# Babel CLI Competitive Gap Report — 2026-06-15 (Updated 2026-06-17)

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
> Generated from: product benchmark (31 scenarios), parity benchmark definitions (8 tasks), adversarial CLI critique (6 dimensions), and market comparison (Claude Code / Codex CLI, June 2026).
> **Audit correction (2026-06-17):** Code audit corrected multiple findings. See inline updates. Major gaps #2, #3, #5 now resolved.

---

## Executive Summary

Babel has **strong governance infrastructure** (permission profiles, BCDP, contract enforcement, checkpoint/restore, QA review loop) and has **closed critical execution gaps** since 2026-06-15.

**Top 5 gaps by impact (updated 2026-06-17):**

| # | Gap | Severity | Impact |
|---|-----|----------|--------|
| 1 | **Adversarial QA wired but env-gated** — `adversarialQALane.ts` wired into `qaStage.ts`; feature gated behind `BABEL_ADVERSARIAL_REVIEW=true`; 24 dedicated tests CI-wired | PARTIAL | Safety differentiator functional but default-off |
| 2 | ~~Daemon non-functional~~ **✅ RESOLVED (2026-06-17)** — Daemon Phases 0-13 fully implemented: IPC transport, job queue consumer, retry/backoff, file watching, crash recovery, graceful shutdown, scheduler, evidence, governance, multi-model, rollback. 19/19 tests pass. | RESOLVED | Headless/CI mode now functional |
| 3 | ~~No autonomous goal loop~~ **✅ RESOLVED** — `babel goal` command + `goalLoop.ts` (plan→execute→verify→enrich→repeat) implemented, gated behind `--experimental` | RESOLVED | Autonomous workflow capability exists |
| 4 | **pipeline.ts large (7,454 lines)** — 43 modules extracted to `pipeline/` directory; root file still heavy but well-modularized | MINOR | Reduced risk from original assessment |
| 5 | ~~No multi-line REPL input~~ **✅ RESOLVED** — Triple-backtick paste, brace-balance auto-paste, `.editor` external editor, Ctrl+R incremental reverse history search all implemented | RESOLVED | REPL UX now competitive |

---

## Capability Scorecard

From `babel benchmark product --json` (2026-06-16):

| Metric | Count |
|--------|-------|
| Total scenarios | 31 |
| Pass | 31 (100%) |
| Implemented | 27 |
| Partial | 4 |
| Gap | 0 |
| Not started | 0 |

**All 4 partial items are Phase 12 Lite feature scorecard dimensions:**

| ID | Status | What it measures |
|----|--------|-----------------|
| `lite_plan_mode_scorecard` | partial | Babel Lite plan mode quality |
| `lite_parallel_review_scorecard` | partial | Parallel review capability |
| `lite_checkpoint_ux_scorecard` | partial | Checkpoint UX quality |
| `lite_verifier_discipline_scorecard` | partial | Verifier contract discipline |

---

## Feature Comparison: Babel vs Codex vs Claude Code

### First-Run UX

| Capability | Babel | Codex CLI | Claude Code |
|-----------|-------|-----------|-------------|
| Install path | `npm install` or clone | `pip install` / npm | curl / Homebrew |
| First command | `babel --help` | `codex` | `claude` |
| Guided onboarding | `babel setup` (checklist only) | Interactive setup | Interactive token + workspace setup |
| Help discoverability | User-shaped `babel "<task>"` | Verb-first | Natural language |
| **Verdict** | **Adequate** — checklist is functional but bare | Polished | Polished |

### Daily Workflow

| Capability | Babel | Codex CLI | Claude Code |
|-----------|-------|-----------|-------------|
| Task routing | `babel "<task>"` intent router | Direct execution | Direct execution |
| Plan/Act separation | `babel plan` / `babel deep` | `codex plan` | `/plan` mode |
| Fix/repair loop | `babel undo`, `babel resume` | Retry on failure | Auto-iterates |
| Small fix detection | SmallFix workflow | N/A | N/A |
| **Verdict** | **Strong** — plan/act/governed separation is best-in-class | Functional | Functional |

### Autonomous Execution

| Capability | Babel | Codex CLI | Claude Code |
|-----------|-------|-----------|-------------|
| Goal-based loop | ❌ None | `codex --goal` | `/goal` command |
| Background daemon | ❌ Non-functional stub | ✅ Native | ✅ Native |
| Headless/CI mode | `babel exec` (no daemon) | `codex exec` | `claude exec` |
| Token budget | `--budget <tokens>` | N/A | N/A |
| **Verdict** | **Gap closed** (2026-06-17) — daemon fully implemented, goal loop exists | Competitive | Competitive |

### Code Generation & Editing

| Capability | Babel | Codex CLI | Claude Code |
|-----------|-------|-----------|-------------|
| Multi-file edits | ✅ Pipeline executor | ✅ | ✅ |
| Refactors | ✅ | ✅ | ✅ Strong |
| Test generation | ✅ Via skills | ✅ | ✅ |
| Sandbox/dry-run | ✅ `babel dry` | ✅ Sandboxed | ✅ |
| **Verdict** | **Competitive** | Competitive | Competitive |

### Review & QA

| Capability | Babel | Codex CLI | Claude Code |
|-----------|-------|-----------|-------------|
| QA review loop | ✅ Single-model (3 loops) | ❌ None | ❌ None |
| Adversarial QA (multi-model) | ⚠️ Wired but env-gated (`BABEL_ADVERSARIAL_REVIEW=true`) | ❌ None | ❌ None |
| BCDP contract enforcement | ✅ Best-in-class | ❌ None | ❌ None |
| Bounded contract checks | ✅ | ❌ None | ❌ None |
| **Verdict** | **Strong on paper, compromised by env-gated adversarial QA** | None | None |

### Isolation & Safety

| Capability | Babel | Codex CLI | Claude Code |
|-----------|-------|-----------|-------------|
| Git worktree isolation | ✅ `babel worktree` | ✅ Per-agent worktrees | ✅ |
| Checkpoint/restore | ✅ Per-tool-call | ❌ | ✅ Session-level |
| Sandbox (no-write) | ✅ | ✅ | ✅ |
| Permission profiles | ✅ 4 presets | ✅ | ✅ |
| **Verdict** | **Strong** — checkpoint granularity exceeds competitors | Standard | Session-level restore |

### Terminal UX

| Capability | Babel | Codex CLI | Claude Code |
|-----------|-------|-----------|-------------|
| TUI/waterfall | ✅ Basic | ✅ | ✅ Rich |
| REPL | ✅ Slash commands | ✅ | ✅ |
| Multi-line input | ❌ | ✅ | ✅ VI-mode |
| Syntax highlighting | ❌ | N/A (minimal) | ✅ |
| History search (Ctrl+R) | ❌ | ✅ | ✅ |
| **Verdict** | **Behind** — functional but unpolished | Minimalist | Rich |

### Multi-Agent

| Capability | Babel | Codex CLI | Claude Code |
|-----------|-------|-----------|-------------|
| Subagent teams | ✅ Agent teams contract | ✅ Agents SDK | ✅ Agent teams |
| Parallel review | ✅ | ✅ | ✅ |
| Workspace locking | ✅ File-based locks | N/A | N/A |
| **Verdict** | **Competitive** | Competitive | Competitive |

### Governance

| Capability | Babel | Codex CLI | Claude Code |
|-----------|-------|-----------|-------------|
| Permission model | ✅ 4 profiles + allowlists | ✅ Basic | ✅ Basic |
| Approval queue | ✅ `babel approvals` | ❌ | ❌ |
| Execution profiles | ✅ 5 profiles | ❌ | ❌ |
| Enterprise policy | ✅ Strict doctor | ❌ | ❌ |
| JIT approval | ✅ Interactive veto | ❌ | ❌ |
| **Verdict** | **Best-in-class** | Minimal | Minimal |

### CI/CD & Automation

| Capability | Babel | Codex CLI | Claude Code |
|-----------|-------|-----------|-------------|
| JSON output | ✅ `--json` | ✅ | ✅ |
| Headless mode | ✅ `babel exec` | ✅ | ✅ |
| GitHub integration | ✅ Ship workflow, draft PR | ✅ | ✅ @claude mentions |
| Scheduled automation | ✅ | ❌ | ❌ |
| **Verdict** | **Strong** — scheduled automation is unique | Standard | Standard |

### Learning & Adaptation

| Capability | Babel | Codex CLI | Claude Code |
|-----------|-------|-----------|-------------|
| Memory extraction | ✅ | ❌ | ❌ |
| Prompt evolution | ✅ Local learning | ❌ | ❌ |
| Skill authoring | ✅ | ❌ | ❌ |
| Model success tracking | ✅ | ❌ | ❌ |
| **Verdict** | **Unique** — no competitor has this | None | None |

### Platform Support

| Capability | Babel | Codex CLI | Claude Code |
|-----------|-------|-----------|-------------|
| Windows | ✅ Primary target | ✅ (Rust) | ⚠️ Limited |
| Linux | ✅ | ✅ | ✅ |
| macOS | ✅ | ✅ | ✅ |
| **Verdict** | **Strong** — Windows-first is unique | Cross-platform | macOS/Linux focus |

---

## Adversarial Critique Findings

### HIGH (note: none remain critical after audit correction)

1. **Adversarial QA is wired but env-gated.** The module (`adversarialQALane.ts`) exports `pickAdversarialModel`, `buildAdversarialReviewPrompt`, and `synthesizeAdversarialResult` — all **imported and used** by `babel-cli/src/pipeline/qaStage.ts` (lines 19-23), which implements `runAdversarialQaGate()`. That function is imported and called from `pipeline.ts` at line 6681. Adversarial QA uses a **different model** (nemotron/NVIDIA-Nemotron-3-Super-120B-A12B via DeepInfra) than the SWE agent's deepseek model. The feature is gated behind `BABEL_ADVERSARIAL_REVIEW=true` (qaStage.ts line 62). When enabled, adversarial QA failure causes the pipeline to loop back with adversarial feedback. No dedicated test file exists. **Severity: PARTIAL (wired but env-gated, no tests).**

2. **Daemon is a hollow shell (already gated).** `daemon.ts` (141 lines) writes a PID file, creates an empty queue JSON, and prints "Daemon started" — but never forks workers, never opens an IPC channel, and never processes queued tasks. `babel exec --background` writes tasks to a JSON file that nothing reads. However, all daemon subcommands (`start`, `stop`, `status`) are gated behind `--experimental` flag (coreCommands.ts lines 3682-3685), and `babel exec --background` is similarly gated (lines 3748-3751). The gating already prevents accidental use. The remaining gap is that the daemon is skeleton-only with no IPC, no worker pool, and no queue consumer. **Severity: MAJOR (gated experimental, but hollow).**

3. **Product scorecard schema exists at correct path.** The file `docs/research/market-research/product-scorecard.schema.json` (97 lines, valid JSON Schema) **exists** at the correct path. `productBenchmark.ts:1108` constructs the path with the `research` segment and loads it correctly. Only a stale benchmark output artifact (from before the `research/` segment was added) references the wrong path — this is not an operational issue. **Severity: NOT-AN-ISSUE (demoted).**

### MAJOR (significant gap vs competitors)

4. ~~No autonomous goal loop.~~ **✅ RESOLVED (2026-06-17).** `babel goal` command + `goalLoop.ts` implements plan→execute→verify→enrich→repeat loop. Gated behind `--experimental` flag. Claude Code `/goal` and Codex autonomous mode remain more mature but Babel now has equivalent infrastructure.

5. **Single-model QA by default; adversarial QA env-gated.** The default QA loop at `pipeline.ts:6361` uses the same model for both plan generation and review — a single-model loop cannot detect its own blind spots. The adversarial QA module exists and is wired (`qaStage.ts` → `pipeline.ts:6681`) but is gated behind `BABEL_ADVERSARIAL_REVIEW=true`. Making it a default-on second opinion pass would close this gap.

6. **`pipeline.ts` is 7,367 lines.** The README acknowledges it "needs decomposition." Extracted modules exist (`grounding.ts`, `contractEnforcement.ts`) but the core state machine remains monolithic. This is a maintenance risk and makes the adversarial QA wiring harder than it should be.

7. ~~No multi-line REPL input.~~ **✅ RESOLVED (2026-06-17).** Triple-backtick paste mode, brace-balance auto-paste, `.editor` external editor command, and Ctrl+R incremental reverse history search all implemented.

8. **No user tutorial or getting-started guide.** `babel setup` prints a checklist but does not execute or verify steps. No interactive onboarding exists.

### MINOR (polish issues)

9. **Deprecated commands inconsistent.** `bl`, `lite`, `full`, `ask`, `do`, `fix` error at CLI but work in the REPL. Users get different behavior depending on entry point.

10. **No Ctrl+R history search in REPL.** Standard REPL feature missing.

11. **`VALID_PROJECTS` static array retained** alongside `@deprecated` annotation. Dynamic discovery exists but the stale constant creates ambiguity.

12. **Stale benchmark output artifact** references `docs/market-research/` (missing `research/` segment) — the code path itself is correct and loads the schema from the existing file.

---

## Prioritized Remediation Actions

### P0 — Ship Blockers (before merging gap-closure to main)

| # | Action | Effort |
|---|--------|--------|
| P0.1 | **Add tests and make adversarial QA default-on.** The module is already wired in `qaStage.ts` and called from `pipeline.ts:6681`; it uses a different model (nemotron via DeepInfra) and is gated behind `BABEL_ADVERSARIAL_REVIEW=true`. Remaining work: add dedicated tests, evaluate whether default-on is safe, and flip the gate. | Medium (1-2 days) |
| P0.2 | **Implement daemon IPC + worker pool + queue consumer (or keep gated indefinitely).** The daemon is already gated behind `--experimental` (coreCommands.ts lines 3682-3685), so it cannot be accidentally triggered. Remaining work: build actual IPC, worker pool, and queue processing, or leave gated as a known-hollow experimental feature. | Large (3-5 days) |

### P1 — Competitive Parity (next 2 weeks)

| # | Action | Effort |
|---|--------|--------|
| ~~P1.1~~ | ✅ **COMPLETE (2026-06-17).** Goal loop (`babel goal` via `goalLoop.ts`). Subagent maturation (plan review, arena evaluation, live Spark, evidence-aware merge — 32 tests). | Done |
| ~~P1.2~~ | ✅ **COMPLETE (2026-06-17).** Pipeline decomposed into 43 extracted modules in `pipeline/` directory (qaStage.ts, executorLoop.ts, etc.). | Done |
| ~~P1.3~~ | ✅ **COMPLETE (2026-06-17).** Multi-line REPL (triple-backtick, brace-balance, `.editor`, Ctrl+R). Universal verifiers (unified interface, 7-ecosystem auto-discovery, wired into 3 lanes). | Done |
| ~~P1.4~~ | ✅ **COMPLETE (2026-06-17).** Getting started guide at `docs/guides/BABEL_GETTING_STARTED.md`. Performance optimizations (cache coherence, deterministic pruning, semantic context injection — 10 tests). | Done |

### P2 — Polish (next month)

| # | Action | Effort |
|---|--------|--------|
| P2.1 | Add Ctrl+R incremental history search to REPL | Small |
| P2.2 | Normalize deprecated command behavior between CLI and REPL | Small |
| P2.3 | Remove `VALID_PROJECTS` static array, replace with dynamic discovery everywhere | Small |
| P2.4 | Add REPL syntax highlighting for code blocks | Medium |
| P2.5 | Implement session-level checkpoint/restore (save and resume mid-pipeline) | Medium |
| P2.6 | Bring P12 Lite scorecard dimensions from `partial` to `implemented` | Medium |

---

## Verdict

Babel's **governance infrastructure is best-in-class** — no competitor has BCDP contract enforcement, execution profiles, JIT approval, or local learning. Its **daily workflow** (plan/act/deep separation) is well-designed and user-shaped.

However, Babel is **not ready to compete as a daily coding agent** until:
1. The adversarial QA module has tests and is default-on (it is wired and env-gated today)
2. The daemon either works or stays gated as experimental (it is already gated today)
3. There is some form of autonomous goal loop

The gap-closure phases (1-4) have built strong foundations. The remaining work is **wiring, maturity, and testing** — the modules largely exist and the contracts are defined, but integration completeness and test coverage are incomplete.

---

*Generated by Babel product benchmark + adversarial CLI critique + market comparison (Claude Code / Codex CLI, June 2026).*
*Sources: [Claude Code overview](https://docs.anthropic.com/en/docs/claude-code/overview), [Codex CLI guide](https://platform.openai.com/docs/guides/code-generation), [Terminal-Bench 2.0](https://securityboulevard.com/2026/06/7-cli-coding-agents-ranked-by-real-terminal-bench-scores/), [15 Tools Compared](https://www.tembo.io/blog/coding-cli-tools-comparison)*
