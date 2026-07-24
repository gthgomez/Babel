---
title: BABEL_CONSOLIDATED_ROI_ROADMAP
version: "2026-06-13 (Synthesized post-sync of [commit-hash])"
status: CURRENT canonical planning source (replaces scattered plans per freshness + manifest updates)
owner: Synthesized from hardening ([commit-hash]), Slice 4 ([commit-hash]), prior remaining-proof (2026-06-05), product gap, pipeline split, claims, freshness audit, and local in-flight code (the feature branch)
goal: Single auditable, ROI-prioritized master for daily-usable governed CLI/TUI work while strictly preserving high-risk rules, co-evolution, evidence, OLS-v9, and BABEL_BIBLE.md layered stack.
---

# BABEL_CONSOLIDATED_ROI_ROADMAP (2026-06)

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
**Version:** 2026-06-29 (Refresh: DAG workflow engine added, executorLoop reconciled, calibration expanded to 40, AO injection benchmark validated, pipeline refactor substantially complete, TUI interactive.ts fully decomposed, docs unstaled)  
**Status:** CURRENT — use this as the primary planning/prioritization source. Old plans now historical or detailed supplements.  
**Owner:** Human + Babel agent self-audit (per hardening pattern)  
**Goal:** Consolidate remaining work across docs + the local dirty-tree implementation into one ROI-ordered roadmap. Focus highest value daily driver + governance impact first. Respect all invariants.

**TL;DR / Current Status (2026-06-29 Refresh):**  
P0.1/P0.2 shipped via a prior PR and verified. **All P0 gates closed.** L6 benchmark: **11/11 pass** (relicRun verifier fixed in [commit-hash]). Adversarial QA: 24 tests CI-wired. B7: 8/8 Babel cells measured live. JIT veto: end-to-end verified (6/6). **Production daemon: FULLY IMPLEMENTED — Phases 0-13 shipped** (IPC transport, job queue consumer, retry/backoff, file watching, crash recovery, graceful shutdown, scheduler, evidence, governance, multi-model, rollback; 20 tests pass). Daemon gated behind soft warning. **DAG workflow engine: IMPLEMENTED** (`workflowEngine.ts` 526 lines, Kahn's algorithm topological sort with parallel dispatch). **Pipeline refactor: SUBSTANTIALLY COMPLETE** (executorLoop reconciled from dead-code to live; 59 modules in pipeline/; pipeline.ts at ~3,400 lines from ~7,500). **Interactive.ts: FULLY DECOMPOSED** (3,631-line god class → 21 focused modules). **Calibration: expanded** from 23 to 40 tasks. **AO injection resistance benchmark: validated** on Llama. Product scorecard schema exists. Plugin/MCP ecosystem complete. B5 multi-file small-fix complete.  
**Lite-gate: 269/269 pass** (was 222/222; 3 regressions from structuredOutput + toolExecutor M9 refactor fixed 2026-06-17).  
**External (Codex/Claude) parity: DEFERRED per user direction (2026-06-17).** `claim_ready` intentionally stays false.  
**Active priorities:** P1.1 subagent maturation → P1.3 universal verifiers → P1.4 performance/context → P2 ecosystem. Real TTY+LLM JIT exercise remains the highest-ROI attendable item.

**Sync note (executed):** Local main was behind by the hardening doc ([commit-hash]). Local edits (heavy on pipeline, contracts, interactive, smallFix, executor, localTools, new incrementalToolDetector + pathScanner) safely preserved on the feature branch (commit [commit-hash]) before ff-only main. See "In-Flight Local Work" section. High-risk files (pipeline.ts, schemas/agentContracts.ts) were already touched locally — any future evolution must obey co-evolution + AGENTS.md.

**Sources synthesized (inventory post-sync):** 
- `docs/plans/BABEL_CLI_HARDENING_TO_PRODUCT_ROADMAP_2026-06.md` (P0 daily UX emphasis + self-audit design)
- `docs/plans/BABEL_TUI_HYBRID_SLICE_4_PROOF_PLAN_2026-06-12.md` (B5/B7/L6 with gates + non-goals)
- `docs/status/BABEL_ROADMAP_REMAINING_PROOF_PLAN_2026-06-05.md` (truth ledger, Phase 12, scoped proofs)
- `docs/plans/PIPELINE_SPLIT_NEXT_PHASES_2026-05-09.md` + local pipeline edits
- `docs/plans/BABEL_CLI_PRODUCT_GAP_PLAN.md`, `BABEL_BORINGLY_USABLE_AGENT_ROADMAP.md`, `BABEL_PRIVATE_COMPANION_LITE_ROADMAP.md` (usability loop, positioning)
- `docs/status/DOC_FRESHNESS_AUDIT_2026-06-12.md`, `.babel/docs-manifest.json`, `claims-matrix.md`
- L6 rerun status (36/44 pass as of 2026-06-12)
- Local in-flight (feature branch + prior stashes pattern): TUI polish, context/path tools, small-fix/executor/agent enhancements, pipeline facade work.

**High-level ROI criteria used (priority order):** 
1. Daily user-shaped impact (P0 hardening quick wins, TUI feel, first-task success).
2. Governance/evidence/reliability ROI (completes Slice 4 proofs, improves L6 from 17/44 baseline — now 36/44, verifiers, live cells, rollback).
3. Completes prior commitments + unblocks (B5/B7/L6 gates, parity honesty before claims).
4. Risk-adjusted (items that touch high-risk zones like pipeline.ts/agentContracts.ts require explicit co-evolution step; favor low-regression work).
5. Doc/process hygiene (single source, freshness closure, manifest discipline).
6. Extensibility leverage (subagents, plugins, export).

---

## Current Synthesized State (Post-Sync 2026-06-13)

**Shipped (per claims 2026-06-12, L6 rerun, Slice 4 prereqs, consolidation + prior PR follow-ups):**
- Slices 1-3 TUI foundation + bounded repair + streaming.
- Coordinated multi-file small-fix (B5 partial; `fixScopeResolver`, smallFix updates landed).
- `test:lite-gate` **222/222**.
- Scoped DeepSeek production gate claim-ready (8/8, with evidence for read-only subagents, verifier/rollback, strict public).
- Daily surface locked: `babel "<task>"`, `babel plan`, `babel deep`, `babel undo`.
- L6 matrix improved to 36/44 pass (from 17/44); many read-only + 1 write-fix.
- Strong evidence artifacts, cost ledger, doctor, catalog validation, terminal status normalization.
- **A prior PR (P0.1/P0.2 core):** IncrementalToolDetector (fences + streaming intent), human JIT veto (JitDenialError, session_state.json + deniedFingerprints, HUMAN_REJECTED), pathScanner (task-derived anchors + BABEL_OPENCLAW_APPROVED_ROOTS locking), workspace_symbol_search (task-aware, read-only), InputCoordinator / TTY support. Verified after that PR (doctor context lock, non-TTY guard active, TTY REPL, symbol search exercised, co-evo in CLI_Executor-v1.0.md + catalog). 7 focused commits + [commit-hash]. (See bottom Resolved note + claims "YELLOW (Verified following that PR)" row.)

**Remaining / In-Flight (high-ROI focus areas, post-2026-06-17 audit refresh):**
- **Real TTY+LLM JIT exercise** — highest-ROI attendable item. Exercise IncrementalToolDetector on live LLM streaming tool intent, coordinator JIT prompt + human veto, full session_state.json + telemetry bundles. Requires attended terminal with API keys.
- **Subagent maturation (P1.1)** — multi-agent coordination with evidence-aware merging under live LLM. Plugin/MCP ecosystem already fully implemented.
- **Universal verifiers (P1.3)** — extend verifier contracts beyond relicRun and adversarial QA to cover all execution lanes.
- **Performance/context optimizations (P1.4)** — compiler caching, selective context pruning, faster manifest compilation.
- **External (Codex/Claude) parity** — DEFERRED per user direction (2026-06-17). `claim_ready` stays false.

**Completed since last audit (2026-06-17 → 2026-06-29):**
- L6 relicRun benchmark: 11/11 pass (fixed in [commit-hash]; was 8 failures with `subtract 4 !== 5`).
- B7: 8/8 Babel cells measured live.
- Adversarial QA: 24 tests CI-wired.
- Daemon: Phases 0-13 fully implemented, 20 tests pass (was 19).
- Lite-gate: 3 regressions fixed, 269/269 pass.
- **DAG workflow engine** (`workflowEngine.ts` 526 lines) — Kahn's algorithm topological sort, conditional edge resolution, parallel dispatch. Wired into streaming path.
- **Pipeline refactor substantially complete** — executorLoop.ts dead-code reconciled and live. 59 modules in pipeline/. pipeline.ts at ~3,400 lines (from ~7,500).
- **Interactive.ts fully decomposed** — 3,631-line god class → 21 focused modules, each under 400 lines.
- **Calibration expanded** — task pool from 23 to 40 tasks.
- **AO injection resistance benchmark** — built and validated on Llama.
- **DeepSeek/DeepInfra API runners** added with streaming improvements.
- **TUI competitive hardening** — streaming polish, two-region rendering, 15 code-review findings addressed.
- **Docs unstaled** — ARCHITECTURE.md (v11 behavioral OS), ADR-003, BABEL_CLI_STAGE_WATERFALLS.md, SECURITY_HARDENING_STATUS.md, PIPELINE_REFACTOR_HARDENED_PLAN.md, claims-matrix.md all updated to reflect current reality.
- Doc reorganization complete. Competitive gap report corrected. Manifest updated.

**Historical In-Flight (pre-PR synthesis snapshot @ [commit-hash], preserved before sync):**  
(Resolved via a prior PR merge + follow-ups — see bottom "**In-Flight Local Work Reference (Resolved)**" and the immediate post-PR section. The details below are retained for provenance of the 2026-06-13 synthesis.)
- Significant changes in: pipeline.ts (+251 net in stat), localTools (heavy), agent/*, interactive, smallFix, execute, evidence, ui/inputCoordinator/runPrelude, runners, services (checkpoints, compaction, indexer, liteFullRouter), schemas/agentContracts.ts, plus new `pathScanner.ts` + `incrementalToolDetector.*.ts`.
- Maps to: P0.1 (pipeline), P0.2 (TUI detector), P0.3 / B5 (smallFix/executor), context/UX (pathScanner, localTools).
- **Critical:** Touches high-risk pipeline.ts + agentContracts.ts. Future commits on this work (or merges) must include prompt co-evolution if contracts change and follow AGENTS Codex rules (feature branch, evidence, draft PR, no unrelated dirty main).

---

## ROI-Prioritized Workstreams

### P0 — Immediate Daily Driver + Hygiene (2-4 weeks, highest ROI for usability + process)
Focus: Make `babel` feel production-usable today; close doc debt that blocks focus.

| Priority | Task (merged sources) | Affected Files (incl. prior PR changes) | ROI Rationale | Target / Deliverables | Success Criteria | Agent Audit Prompt |
|----------|-----------------------|------------------------------------|---------------|-----------------------|------------------|--------------------|
| P0.1 | Decompose pipeline.ts + continue facade work (hardening P0.1 + pipeline split plan + prior PR delivery of IncrementalToolDetector/JIT + session_state). Core shipped (7 focused commits + co-evo [commit-hash]). | `babel-cli/src/pipeline.ts` + pipeline/*, agent/session/planHandoff, execute, schemas/agentContracts.ts (high-risk) | High daily + arch leverage; unblocks future. Core landed + verified following that PR (doctor, non-TTY guard, units); next is real TTY exercise + L6 impact. Risk: must co-evolve on any future edits. | Facade orchestration only; remaining in modules; <~800-1500 LOC root if possible; tests. | Typecheck + lite-gate green; existing behavior preserved; co-evolution artifacts if contracts touched. | "Audit the current pipeline.ts + prior PR changes against AGENTS high-risk + Slice 4 non-goals. Flag any missing co-evolution." |
| P0.2 | Polish interactive TUI/REPL + context tools (hardening P0.2 + prior PR integration of pathScanner + incrementalToolDetector + InputCoordinator + workspace_symbol_search). Primitives + integration exercised in follow-ups. | `babel-cli/src/interactive.ts`, `src/ui/*` (new incrementalToolDetector, pathScanner, inputCoordinator, runPrelude, waterfall), cli/ | Highest user-shaped daily ROI (first-task time, "feels native"). That PR advanced directly; next: full realistic TTY+LLM tasks + metrics (veto rate, detector fire, session_state). | Richer streaming/progress, / command UX, context preview/stats, mouse-friendly where feasible. | Interactive `babel` on realistic tasks <5 min first success; positive operator feedback. | "Compare current interactive.ts + prior PR TUI/context changes to hardening P0.2 and Grok/Claude patterns. Top frictions + quick wins." |
| P0.3 | Expand live reliability proofs (hardening P0.3/P1.3 + Slice 4 B7/L6). **L6: 11/11 pass** (relicRun verifier fixed in [commit-hash]). B7: 8/8 Babel cells measured. External parity deferred. | `src/doctor.ts`, `execute.ts`, reliability scripts, benchmark/evidence, verifiers | High governance ROI; builds trust + unblocks claims. L6 target met. External cells deferred per user direction (2026-06-17). | JIT/human-supervision dimension tracked per L6 doc following that PR; real TTY+LLM exercise pending. | 80%+ on defined pilots; explicit skips; L6 evidence updated. | "Run current matrix on main. Report verifier gaps for non-relicRun lanes." |
| P0.4 | Doc synthesis + freshness/claims hygiene (freshness checklist + this master + manifest + claims updates) | This file, plans/README.md, .babel/docs-manifest.json, DOC_FRESHNESS_AUDIT, claims-matrix | High process ROI — reduces future maintenance, makes all other work discoverable. Low risk. **LARGELY COMPLETE** (docs reorganized 2026-06-17, competitive gap report corrected, manifest updated). | Single master + updated refs; no stale counts as primary; hardening + Slice 4 integrated. Freshness sweep largely done. | Freshness labels accurate; plans/README points here; manifest maintainedDocs includes master. | "Audit this synthesis against freshness checklist + manifest gaps. Any remaining stale refs?" |

**P0 Exit Gate:** Daily `babel` (plan/deep/fix) on realistic tasks feels production-usable with full evidence; new P0.1/P0.2 JIT/context features exercised in real TTY+LLM sessions (detector, veto, session_state, telemetry); pipeline work safely progressed with co-evo; L6 evidence + this master landed; all trusted commands green.

### P1 — Capability & Reliability Hardening (4-8 weeks)

| Priority | Status | Shipped |
|----------|--------|---------|
| P1.1 | **COMPLETE (2026-06-17)** | Plan review subagent wired into AgentSession; Arena evaluation (2-4 parallel approaches, scoring, winner selection — 19 tests); Live Spark enrichment (optionally LLM-powered pre-subagent); Evidence-aware merge (quality-weighted dedup — 13 tests) |
| P1.2 | **COMPLETE** | `plugins.ts`, `mcpDoctor.ts`, `mcpTransport.ts` implemented |
| P1.3 | **COMPLETE (2026-06-17)** | Unified Verifier interface + registry; auto-discovery for 7 language ecosystems (Node, Python, Rust, Go, Java, Make, CMake); verifiers wired into plan/report/review lanes |
| P1.4 | **COMPLETE (2026-06-17)** | Cache coherence manager (unified invalidation across 3 caches); deterministic pruning fallback (heuristic-based, pre-LLM); semantic index context injection via FTS5 |
| P1.5 | **DEFERRED** | External (Codex/Claude) parity per user direction. Internal Babel benchmarks remain in scope. |

**New modules (P1.1/P1.3/P1.4):** `arenaRunner.ts`, `evidenceMerge.ts`, `verifierContract.ts`, `autoVerifierDiscovery.ts`, `cacheCoherence.ts`, `semanticContext.ts`, plus wiring into existing lanes.
**New tests:** ~65 (19 arena + 13 evidence merge + 10 cache coherence + verifier discovery coverage).
**P1 Exit Gate:** ✅ Subagents (plan review + arena + Spark) competitive with evidence. ✅ Verifiers universal across all lanes. ✅ Performance optimizations (caching, pruning, indexing). ✅ P1.5 explicitly deferred.

### P2 — Ecosystem & Positioning (2-4 months)
- Marketplace-lite for plugins/MCP.
- Advanced TUI (split views, persistent).
- Git/CI (draft PRs etc.).
- Public export hardening + comprehensive onboarding.
- Visuals/demos/comparison table (vs Grok Build / Claude Code / Codex).

**P2 Exit Gate:** Public positioning with "why Babel" + measured external parity where claimed.

---

## Governance Constraints & Non-Negotiables (Consolidated)
- **High-risk zones (never bypass):** 00_System_Router/, 01_Behavioral_OS/, prompt_catalog.yaml, babel-cli/src/pipeline.ts, babel-cli/src/compiler.ts, babel-cli/src/schemas/agentContracts.ts, tools/resolve-control-plane.ps1 (AGENTS.md).
- **Co-evolution rule (Slice 4 non-goal + AGENTS):** Edits to pipeline.ts or agentContracts.ts require corresponding prompt updates in the **same change set**. (A prior PR already performed the required co-evo for the delivered changes — [commit-hash]; audit before any future merge/PR touching these files.)
- **OLS-v9 only** for typed runtime; preserve Behavioral OS / Domain Architects / Skills separation (edits to 01_Behavioral_OS are global breaking).
- **Evidence first:** All runs produce bundles, ledgers, terminal status, checkpoints/rollbacks. `claim_ready` stays conservative (false until external cells + stronger axes).
- **User-shaped + honest:** Daily surface `babel "task" | plan | deep | undo`. No over-claims. Freshness audit discipline.
- **Private lab:** Validate in this repository; export only after gates (per manifest + release checklists).
- **Codex workflow (AGENTS):** For any ship/PR involving high-risk zones or follow-up branches: safe inspection, intentional staging on feature, focused commit, non-main push, draft PR. Dirty tree is hard-risk signal — do not mix with unrelated.
- **Self-audit:** Every major step (incl. this master and post-PR follow-ups) should be auditable by running the prompt below against BABEL_BIBLE.md + actual files. Post-PR audit re-run completed 2026-06-13 (see audit/roi-self-audit-post-pr45-20260613.md): P0.1/P0.2 On Track with co-evo cleared, no violations.

**Recommended periodic self-audit invocation (from hardening, adapted):**
```
Read BABEL_BIBLE.md + AGENTS.md + this master. Audit against current babel-cli/ (incl. current main + any active follow-up branches if relevant) and docs.

Tasks:
1. Read files listed in current P0/P1 items + any recent diff on an active follow-up branch.
2. For each item: Status (On Track/Partial/Blocked), Evidence, Concrete next action.
3. Flag any high-risk or co-evolution violations.
4. Revise P0 4-week plan + ROI if drift found.
5. Output updated claims/freshness impacts.
```

---

## Verification Commands (Run After Changes)
```powershell
npm --prefix .\babel-cli run typecheck
npm --prefix .\babel-cli run build
npm --prefix .\babel-cli run test:lite-gate
npm --prefix .\babel-cli run check:source-provenance
node .\babel-cli\dist\index.js doctor --scope all --json
node .\babel-cli\dist\index.js benchmark parity --json   # claim_ready remains false
node .\babel-cli\dist\index.js benchmark production --json
powershell -ExecutionPolicy Bypass -File .\tools\validate-catalog.ps1
# Optional: reliability matrix, live proofs when keys present
```

---

## Immediate Post-PR Follow-up Priorities (from self-audit + summary, 2026-06-13)
- Real TTY terminal + LLM task (e.g. context-heavy task under the workspace triggering tool intent) → capture detector fire (IncrementalToolDetector on <|tool_start|>/end), coordinator JIT prompt + human veto, session_state.json + deniedFingerprints, telemetry, pathScanner anchor lock, workspace_symbol_search (read-only under approved roots). Use sim baselines in evidence/jit-consistency-audit-20260613.md, doctor-post-pr45-*.json, cli-evidence-*.log, jit-non-tty-*.log.
- Re-gen full evidence bundles post-real runs (update audit/ + evidence/ with actual metrics: latency, veto/false-positive rate, detector fire rate, context/symbol quality).
- L6 matrix refresh (add JIT/human-supervision cases as tracked dimension per post-PR note in BABEL_L6_MATRIX_RERUN_2026-06-12.md; re-run to measure impact on the remaining 8 write-fix cases (relicRun verifier 4 !== 5) or new coverage). Update L6 doc + claims.
- Update roadmap/claims/freshness post-real evidence (append short delta to this section and the bottom Resolved note; mark additional "Verified following that PR" items conservatively).
- When the above complete: re-run the exact self-audit prompt defined in the Governance section below against current main + active follow-up branch; append a "Post-real-TTY delta" here. No additional prompt co-evolution expected (per prior audits).
- 2026-06-14 session (commit [commit-hash] + [commit-hash] fixes + TTY/LLM exercises): .gitignore updated to ignore mcps/ (local MCP integration noise now hidden); AGENT_PROMPT committed as executed task artifact. Clean full doctor --scope all (post-hygiene + post-tty-exercise-...) + workspace doctor captured into evidence/ (overall "warn", 3/0 or 1/0 — only documented godot_td external prereq + stale pointers; 0 fails; env + multiple provider keys healthy; typecheck + catalog clean post-exercises).
  - REPL/TTY sim launch (`node .\babel-cli\dist\index.js`): Confirmed exact banner "BABEL · [PENDING] · auto-detect · route-selected" + prompt "type a task, or /help for commands". InputCoordinator / new TTY paths active (banner saved to evidence/tty-repl-banner-20260614.txt).
  - Non-TTY high-risk guard exercise (propose update on pipeline.ts): Hit "[VCS] Context locked to (exact match)" via pathScanner/approved-roots; safe read-only proposal generated with post-PR comment (auto-apply: false, no mutation). Guard behavior for non-interactive confirmed.
  - Live LLM context-heavy symbol search + pathScanner ("search symbols for IncrementalToolDetector and pathScanner"): Full exercise of workspace_symbol_search + task-derived anchors. Key files identified: babel-cli/src/ui/incrementalToolDetector.ts (main logic + JitDenialError for human JIT veto), pathScanner.ts (VCS pre-flight), repoSearch.ts (uses extractFolderTokens), deepSeekApi.ts (consumer). Context locks observed. "Babel Read-only report Ready". New run artifacts (e.g. runs/babel-lite/20260614T020428Z-report-9f405bae ~19k tokens + cost). Post-PR changes referenced.
  - **Live monitored TTY/LLM test (monitor task 019ec3ea-7ba1-77f1-8d94-9b6657187014)**: Real-time streamed execution of complex investigation task via `node dist` with live provider. Immediate pathScanner activation: `[VCS] Context locked to (exact match): /workspace-root/.tmp-babel-audit/tools`. Produced large read-only report (41,405 tokens, $0.010349, run runs/babel-lite/20260614T021627Z-report-9e6abac0). Model used context/symbol tools to inspect files (AGENTS.md, PROJECT_CONTEXT.md, pipeline/manifestContext.ts, parity fixtures, compiled skills). Provider repair after 1 retry. "Output review: report depth issue detected" (internal flag). Full log: evidence/live-tty-llm-test-20260613-211625.log. Confirmed context tools/locking in actual live LLM-powered run; stayed in read-only report mode (no model-emitted <|tool_start|> fences or direct JIT veto path in this execution).
  - **Second live monitored tool-emission test (monitor task 019ec3ee-bfe4-7d91-8668-03c04fc0182a)**: Explicit prompt engineering to force LLM to emit tool calls in raw <|tool_start|> workspace_symbol_search with query is IncrementalToolDetector <|tool_end|> format (plus instruction to show tool calls and propose roadmap update). Routed to read-only report mode again. Context lock on .tmp-babel-audit\docs. Internal symbol search now correctly located the files: babel-cli/src/ui/incrementalToolDetector.ts (with JitDenialError for human JIT veto) and babel-cli/src/services/pathScanner.ts (VCS pre-flight). Model proposed concrete regression addition: "Add tool-emission regression test for IncrementalToolDetector: verify that JIT tool detection correctly yields denial when a duplicate policy-blocked tool call is attempted, and acceptance otherwise." New run: runs/babel-lite/20260614T022106Z-report-ae02556a (19,719 tokens, $0.007163). Provider repair after 1 retry + "Output review: report depth issue detected". Still system-internal tool mediation (no visible raw LLM fence emission in this read-only investigation flow). Strong validation that the context layer (pathScanner + workspace_symbol_search) is now accurately surfacing post-PR JIT code in live runs. Pre/post doctors remained healthy (warn/3/0). JIT log and live log (if captured via tee) updated.
  - No session_state.json or deniedFingerprints materialized in this non-interactive batch (consistent with prior; full persistence + detector fire on <|tool_start|>/end + coordinator JIT prompt + human veto requires true interactive TTY + live LLM streaming tool intent). Dedicated JIT approval log updated with details (evidence/jit-approval-log-20260614-tty-exercise.txt). Post-exercise runs and doctors added to evidence/.
  - Quick verifs post-exercises: typecheck clean, catalog 0 warnings/errors. All new features (IncrementalToolDetector paths, JitDenialError/veto, pathScanner anchors, workspace_symbol_search, context locking, InputCoordinator) wired and exercised safely in read-only + proposal lanes using live LLM. Full real TTY + LLM with model-driven tool fences + veto opportunity + session_state still the lead pending item.

---

## Next Immediate Actions (Updated 2026-06-17)
1. (Done) Prior PR merge + follow-ups. P0.1/P0.2 shipped. Co-evolution cleared. L6 11/11 pass. B7 8/8.
2. (Done 2026-06-17) Lite-gate 3 regressions fixed (toolExecutor M9 shell_exec routing, structuredOutput answer_first Target-less format, absenceClaimPattern regex statefulness). 269/269 pass.
3. (Done 2026-06-17) Daemon Phases 0-13 fully implemented (IPC, queue, scheduler, file watcher, crash recovery, evidence, governance, multi-model, rollback). 19/19 tests pass.
4. (Done 2026-06-17) Consolidated ROI roadmap refreshed: daemon status corrected, lite-gate count updated, external parity explicitly deferred per user direction.
5. (Active — P1.1) **Subagent maturation**: real TTY+LLM multi-agent coordination with evidence-aware merging. Exercise IncrementalToolDetector + human JIT veto with live LLM streaming.
6. (Active — P1.3) **Universal verifiers**: extend verifier contracts beyond scoped lanes (currently: relicRun, adversarial QA).
7. (Next — P1.4) **Performance/context optimizations**: compiler caching, selective context pruning, faster manifest compilation.
8. (Periodic) Re-audit this master after merges (run the prompt in the Governance section; append deltas here).

*This is the single source for planning. Old plans are now supplements or archived. Implementation truth remains main + passing gates + evidence.*

---

**In-Flight Local Work Reference (Resolved):** Merged via a prior PR (review/refactor-pr44-20260613 @ [commit-hash], 2026-06-13). 7 focused commits (split history + co-evolution [commit-hash] for high-risk pipeline/agentContracts changes). Post-merge follow-ups (2026-06-13): evidence/jit-consistency-audit-20260613.md (tests green except documented WIP parity; non-TTY guard, TTY launch, context/symbol search exercised); claims/L6/ROI updated "Verified following that PR"; new safeguards (incremental streaming intent, human veto with session_state/deniedFingerprints, pathScanner anchor locking + approved-roots, workspace_symbol_search). Co-evo in CLI_Executor-v1.0.md etc. (no further prompt updates needed per audit). Map as shipped for P0.1/P0.2. Follow AGENTS for any future evolution.

---

## Audit Corrected Status (2026-06-17)

The 2026-06-17 code audit examined the working tree and docs against this roadmap. Below is a compact summary of what was found complete vs what remains.

| Area | Previous Status | Audit Verdict | Details |
|------|----------------|---------------|---------|
| P0.1 pipeline decomposition | "In progress" (prior PR) | COMPLETE -- 43 extracted modules | `pipeline/qaStage.ts`, `pipeline/executorLoop.ts` etc. `pipeline.ts` at 7,454 lines (still large but well-modularized). |
| P0.1 adversarial QA | "Unclear / possibly dead code" | WIRED -- gated behind `BABEL_ADVERSARIAL_REVIEW=true` | `adversarialQALane.ts` → `qaStage.ts` → `pipeline.ts:6681`. Uses nemotron vs deepseek. |
| P0.2 multi-line REPL | "In progress" | COMPLETE | Triple-backtick paste, brace-balance auto-paste, `.editor` external editor, Ctrl+R incremental reverse history search. |
| P0.2 goal loop | "In progress" | COMPLETE -- gated behind `--experimental` | `babel goal` command + `goalLoop.ts` (plan→execute→verify→enrich→repeat). |
| P0.3 L6 target | "36/44, targeting ≥35/44" | **MET** (36/44) | L6 target of ≥35/44 achieved. Remaining 8 failures are relicRun verifier `subtract 4 !== 5` (single root cause). |
| P0.4 doc synthesis | "In progress" | **LARGELY COMPLETE** | Docs reorganized 2026-06-17, competitive gap report corrected, manifest updated. |
| B5 multi-file small-fix | "Partial" | **COMPLETE** | `fixScopeResolver.ts` with `detectMultiFileSmallFix()`, `MAX_SEQUENTIAL_FIX_FILES = 4`, implicit file resolution, coordinated execution, parity fixture. |
| B7 live proof | "Partial" | **8/8 Babel cells measured live** | All 8 parity tasks now have live Babel measurements (tasks 1-5 via June 17 runs, tasks 6-8 via 2026-06-17 follow-up). External (Codex/Claude) cells remain at 0/16. `claim_ready: false` until external cells measured. |
| Plugin/MCP ecosystem | Not tracked in roadmap | **COMPLETE** | `plugins.ts`, `mcpDoctor.ts`, `mcpTransport.ts`, comprehensive tests -- all implemented. |
| Product scorecard schema | Not tracked | **COMPLETE** | Exists at correct path. |
| Daemon | Shipped (Phases 0-13 via [commit-hash], [commit-hash], [commit-hash], [commit-hash]) | **FULLY IMPLEMENTED — 19/19 tests pass.** IPC transport, job queue consumer, retry/backoff, file watching, crash recovery, graceful shutdown, scheduler, evidence, governance, multi-model, rollback. Gated behind soft warning. |
| Getting started guide | Not tracked | **COMPLETE** | `docs/guides/BABEL_GETTING_STARTED.md` as step-by-step tutorial; `babel setup` prints static checklist. |
| Adversarial QA tests | Not tracked | **24 TESTS** (16 unit + 8 integration, CI-wired) | `adversarialQALane.ts` wired into `qaStage.ts` → `pipeline.ts:6681`. 24 tests exist and run in CI via `test:unit`. Model configurable via `originalQaModel` param. Remaining gap: pipeline-integration decision loop test. |