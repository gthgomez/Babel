---
title: BABEL_CLI_HARDENING_TO_PRODUCT_ROADMAP
version: "2026-06-13 (Draft for agent + human review) — 2026-06-17: P0 complete, P1.1/P1.3/P1.4 complete, P1.5 deferred"
status: Largely implemented — see BABEL_CONSOLIDATED_ROI_ROADMAP_2026-06.md for current state
owner: Jonathan (with Babel as primary auditor + implementer)
goal: Evolve `babel-cli/` into a hardened, daily-usable, production-grade coding agent CLI/TUI.
---

# BABEL_CLI_HARDENING_TO_PRODUCT_ROADMAP

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
> **2026-06-17 Update:** Phase 0 items (P0.1-P0.4) and Phase 1 items (P1.1-P1.4) are now complete. See [BABEL_CONSOLIDATED_ROI_ROADMAP_2026-06.md](./BABEL_CONSOLIDATED_ROI_ROADMAP_2026-06.md) for the current canonical planning source. P1.5 (external parity benchmarks) deferred per user direction.

**Version:** 2026-06-13 (Draft for agent + human review)  
**Status:** Proposed — ready for Babel agent audit against actual files  
**Owner:** Jonathan (with Babel as primary auditor + implementer)  
**Goal:** Evolve `babel-cli/` into a hardened, daily-usable, production-grade coding agent CLI/TUI that matches or exceeds the polish and capability of Grok Build, Claude Code, and Codex CLI while preserving (and amplifying) Babel’s unique strengths in determinism, evidence, governance, and multi-model control.

---

## 1. Executive Summary & Vision

Babel’s CLI is already a sophisticated **autonomous Coding Agent runtime** with an optional governed pipeline mode (Prompt OS). It excels at safe, auditable, catalog-driven prompt assembly and evidence collection.  

**Target State (6–9 months):**  
A polished, trustworthy terminal coding agent that feels as fluid as Grok Build (TUI + parallel agents) or Claude Code (deep reasoning + hooks) for daily work, while offering superior audit trails, rollback safety, multi-model routing, and explicit governance that the others lack.

**Unique Value Proposition:**  
“The governed, evidence-backed, deterministic multi-model agent — built for developers who want power *with* control and proof.”

**Key Constraints (non-negotiable):**  
- Never weaken behavioral rules, catalog discipline, or evidence requirements.  
- Keep `BABEL_BIBLE.md` + layered stack as the invocation contract.  
- Treat this repository as the lab; export only after private validation.

---

## 2. Current State Snapshot (as of a prior main commit)

**Strengths (leverage these):**  
- Strong prompt compilation & routing (`compiler.ts`, `routingEngine.ts`, OLS-v9).  
- Excellent governance surface (`doctor.ts`, evidence, checkpoints, sandbox profiles, confidence/budget gates).  
- Local Mode session lifecycle + run consistency.  
- MCP, plugins, subagent teams foundations.  
- Honest self-documentation and reliability loops.

**Known Gaps (from code + docs review):**  
- `pipeline.ts` is monolithic.  
- TUI/interactive experience (`interactive.ts`) is functional but not as rich/polished as competitors.  
- Live provider-backed end-to-end governance is under-proven.  
- Subagent parallelism and merging need maturation.  
- Plugin/MCP ecosystem exists but lacks marketplace-like ease and discoverability.  
- No public comparative benchmarks or strong “parity claims” artifacts.  
- Verifiers are scoped rather than universal.

**Relevant Existing Plans (reference these — do not duplicate):**  
- `docs/plans/BABEL_CLI_PRODUCT_GAP_PLAN.md`  
- `docs/plans/BABEL_CLI_AGENT_PHASE_ROADMAP.md`  
- `docs/plans/PIPELINE_SPLIT_NEXT_PHASES_2026-05-09.md`  
- `docs/plans/BABEL_TUI_HYBRID_SLICE_4_PROOF_PLAN_2026-06-12.md` and earlier TUI plans  
- `docs/plans/BABEL_LOCAL_V1_1_PHASE_4_5_PLAN.md` and related Local Mode docs  
- `BABEL_BIBLE.md`, root `README.md`, `STRUCTURE.md`

---

## 3. Prioritized Roadmap

### Phase 0: Foundation & Daily UX Polish (P0 — Target: 2–4 weeks)
Focus: Make the CLI feel like a real daily driver immediately.

| Priority | Task | Current Files to Inspect/Audit | Target Changes / Deliverables | Success Criteria (measurable) | Agent Audit Prompt Example |
|----------|------|--------------------------------|-------------------------------|-------------------------------|---------------------------|
| P0.1 | Decompose `pipeline.ts` into clear stages | `babel-cli/src/pipeline.ts` (and tests) | Split into `routing/`, `compile/`, `execute/`, `verify/`, `complete/` modules + shared contracts | Pipeline file < 800 LOC; all existing tests still pass; new stage tests added | “Audit the proposed pipeline decomposition against current `pipeline.ts`. List any missing contracts or test coverage gaps.” |
| P0.2 | Polish Interactive TUI / REPL | `babel-cli/src/interactive.ts`, `src/ui/`, `src/cli/` | Richer streaming, progress indicators, better error/recovery UX, mouse-friendly elements where feasible, improved `/` command discoverability | Interactive mode feels “native terminal agent” level for basic tasks; user feedback loop positive | “Compare current interactive experience to Grok Build/Claude Code TUI patterns. Identify top 5 UX friction points with file references.” |
| P0.3 | Expand live provider reliability proofs | `babel-cli/src/doctor.ts`, reliability tests, `execute.ts`, benchmark scripts | Full end-to-end runs with real keys required for “full” matrix; explicit skip reporting; higher success thresholds on pilot tasks | 80%+ pass rate on defined pilot tasks with full evidence bundles; all skips surfaced | “Run the current reliability matrix and report gaps vs. competitor live usage patterns.” |
| P0.4 | Quick-win UX: better defaults, context preview, stats | `src/index.ts`, commands, `interactive.ts` | One-command “daily happy path”; improved `@file` / context handling; instant `/stats` | New users complete first real task in < 5 min with clear feedback | — |

**Phase 0 Exit Gate:** `babel interactive` + `babel run` on realistic tasks feel production-usable; pipeline decomposition merged; live reliability matrix green on defined pilots.

### Phase 1: Capability & Reliability Hardening (P1 — Target: 4–8 weeks after P0)
Focus: Close the biggest functional gaps vs. competitors while strengthening governance.

| Priority | Task | Current Files | Target Changes | Success Criteria | Agent Audit Prompt |
|----------|------|---------------|----------------|------------------|--------------------|
| P1.1 | Mature subagent teams + parallel execution | `src/agent/`, pipeline stages, merge logic | Parallel subagent orchestration, Arena-style evaluation mode, improved isolation + evidence-aware merging | Can reliably run 2–4 coordinated subagents on complex tasks with clean merge | “Audit subagent implementation vs. Grok Build parallel agents and Claude hooks. Identify gaps in parallelism and evidence flow.” |
| P1.2 | Strengthen plugin/MCP ecosystem | `src/mcp/`, plugins system, manifest handling | Easier plugin discovery/install, more governed tool surfaces, hook examples | 3–5 high-value plugins or MCP servers “just work” out of box | “Evaluate current MCP/plugin surfaces against Grok marketplace and Claude MCP. Propose minimal viable marketplace features.” |
| P1.3 | Universal + scoped verifiers | `src/evidence/`, `taskCompletion.ts`, confidence gates | Expand verifier contracts; add universal safety nets with clear scoping | Verifier coverage documented and measurably higher on pilot tasks | — |
| P1.4 | Performance & large-context optimizations | `compiler.ts`, context injection, resolver | Faster manifest compilation; better pruning / selective context | Noticeable speed improvement on large repos; token budgets respected | — |
| P1.5 | Public benchmark & claims artifacts | `docs/plans/`, benchmark scripts, new `claims-matrix.md` | Run external benchmarks (Terminal-Bench, SWE-bench subsets); publish gap analysis + parity roadmap | Clear public positioning doc exists; internal benchmarks show measurable progress | “Cross-reference all existing benchmark/roadmap docs in `docs/plans/` and synthesize a single consolidated claims vs. gaps view.” |

**Phase 1 Exit Gate:** Subagent parallelism + plugin surfaces demonstrably competitive; live provider runs reliable; benchmark claims published internally.

### Phase 2: Ecosystem, Polish & Positioning (P2 — Target: 2–4 months after P1)
Focus: Make Babel feel like a complete product with its own ecosystem flywheel.

- Plugin/MCP marketplace-lite (discovery, versioning, security pinning — inspired by Grok).  
- Advanced TUI features (split views, persistent sessions, rich diffs).  
- Deeper git/CI integration (draft PRs, scheduled reviews, etc.).  
- Public export readiness (`Babel-public` sync process hardened).  
- Comprehensive documentation & onboarding refresh.  
- Optional: Visual architecture diagrams, video demos, comparison table vs. Grok Build / Claude Code / Codex.

**Phase 2 Exit Gate:** Babel positioned publicly as a credible, differentiated option with clear “why choose Babel” messaging.

---

## 4. How to Use This Roadmap with Your Agent (Babel)

**Recommended Invocation (copy-paste ready):**

```
Read BABEL_BIBLE.md, then use Babel to audit the following roadmap document against the actual current state of the babel-cli/ package and related docs.

Roadmap file: [paste or @file the full content of this doc]

Specific audit tasks:
1. For every “Current Files to Inspect” entry, actually read the latest versions of those files.
2. Identify any drift between the roadmap assumptions and reality.
3. For each task, output: Status (On Track / Partial / Blocked), Evidence from files, Recommended next concrete action or edit.
4. Prioritize the P0 items and give a revised 4-week execution plan.
5. Flag any non-negotiable governance or catalog rules that the roadmap might accidentally weaken.
```

Run this periodically (e.g., after each major merge) to keep the plan grounded.

---

## 5. Risks, Dependencies & Governance

- **Risk:** Over-optimism on live provider reliability → Mitigate with explicit “skipped tests must be reported” rule.  
- **Risk:** TUI work becomes scope creep → Mitigate by defining “good enough for daily driver” MVP first.  
- **Dependency:** Existing plans in `docs/plans/` (especially pipeline split, TUI, Local Mode, reliability).  
- **Governance:** All changes must still pass catalog validation, doctor checks, and evidence requirements. New features should extend (not bypass) the layered stack.

---

## 6. Success Metrics (Track These)

- **UX:** Time-to-first-useful-edit on realistic tasks; subjective “feels like a real agent” score.  
- **Reliability:** % of pilot tasks completed with full evidence + verifier pass (target: rising toward competitor levels).  
- **Governance:** % of runs with complete evidence bundles and no protocol violations.  
- **Extensibility:** Number of working plugins/MCP integrations and subagent use cases.  
- **Positioning:** Existence of clear comparison table + benchmark artifacts.

---

## 7. Next Immediate Actions (Human + Agent)

1. Save this document (pushed via connector).  
2. Run the audit invocation above with your Babel agent.  
3. Share the agent’s output — we can then refine tasks, create issues, or start editing specific files (e.g., begin pipeline decomposition).

---

*This roadmap is designed to be **auditable and actionable** by Babel itself.*