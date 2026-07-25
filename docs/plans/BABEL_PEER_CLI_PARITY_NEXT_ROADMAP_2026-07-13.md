<!-- License: MIT — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-07-13
purpose: Next product roadmap after thrash control + Tier A/B/C observability/NL UX shipped — validate, productize, then selective remeasure
parent: docs/plans/BABEL_VS_GROK_CLI_GAP_AND_FIX_PLAN_2026-07-12.md
related: docs/plans/BABEL_RUN_OBSERVABILITY_AND_NL_UX_PLAN_2026-07-12.md
related: docs/plans/CHAT_HARNESS_ROADMAP_2026-07-12.md
factory: plans/factory/campaigns (Tier D first; do not auto-start E/F)
-->

# Babel Peer-CLI Parity — Next Roadmap (post A/B/C)

**Date**: 2026-07-13  
**Status**: ACTIVE — **this is the current execution roadmap**  
**Branch context**: the implementor feature branch  
**Supersedes for “what to build next”**:  
- BABEL_VS_GROK_CLI_GAP_AND_FIX_PLAN_2026-07-12.md (diagnosis + Layer 0–3 strategy — **implementation complete**, vault-only)
- BABEL_RUN_OBSERVABILITY_AND_NL_UX_PLAN_2026-07-12.md (Tier A/B/C WPs — **factory campaigns passed**, vault-only)

---

## 1. Executive summary

Babel is **no longer held back primarily by missing control honesty or missing run artifacts**.

| Layer | Status | Evidence |
|-------|--------|----------|
| **L0 thrash control** | **Shipped** | `chatZeroWritePolicy`, phase verify-after-writes, `mutate_only`, hard-stop, shell-in-fuse — commit `[commit-hash]` |
| **Tier A observability** | **Shipped** | `toolCallExport`, `policyEventLog`, routing receipts, patch reality, observation tails, harness paths — commit `[commit-hash]` |
| **Tier B belief/decisions** | **Shipped** | Factory campaign `20260712-230058-tier-b` **passed** (B3→B4→B1→B2) |
| **Tier C NL UX** | **Shipped** | Factory campaign `20260712-235904-tier-c` **passed** (C1→C2→C3) |
| **Live validate (A08 smoke with rich artifacts)** | **Not done** | Still required before multi-cell remeasure |
| **Playbook ↔ policy alignment** | **Partial** | Single-file playbook improved; explicit “patch before env-fighting pytest” not fully locked |
| **Interactive product defaults** | **Partial** | Modules exist; coding-profile defaults + Flash/Pro parity need product pass |
| **Eval truth (docker / gold)** | **Deferred** | Layer 4 — after selective remeasure decision |

**What holds peer-CLI parity back now** is not more modules — it is:

1. **Unproven live loop** (one capped cell with failure/success card + non-empty tool/policy timeline)  
2. **Prompt/policy mixed messages** (RC9 residual)  
3. **Product defaults** that still feel harness-first rather than Grok/Claude-class interactive  
4. **Eval environment asymmetry** (Windows gold_diff vs real pytest) — later  

This roadmap is factory-ready: **Tier D first** (sequential), stop at exit gate; **Tier E/F require explicit user start**.

---

## 2. Goals & non-goals

### Goals

1. **Validate** the shipped stack on one live capped SWE cell (or early BLOCKED with full evidence).  
2. **Align** playbooks and operator docs with thrash/policy reality.  
3. **Productize** interactive “coding agent” defaults so vague NL feels peer-CLI.  
4. **Remeasure selectively** (2–3 cells) only after D exit gate; full SWE-A only if metrics hold.

### Non-goals

- Re-implement A1–C3 modules  
- A08-only or cell-specific knobs  
- Full A01–A10 burn as first gate  
- V8 orchestrator / deep-mode pipeline rewrite  
- Auto-starting Tier E or F after D  

---

## 3. Definition of done (product)

Babel matches **Grok CLI / Claude Code-class coding UX** for the operator when:

| # | Criterion | Gate |
|---|-----------|------|
| 1 | Single-file bugs follow localize → `str_replace` → verify by default | D4 smoke + playbook D2 |
| 2 | Failures leave complete artifact bundle (tools, policy, patch, card, paths) | D1 offline + D4 live |
| 3 | Zero-write thrash cannot exhaust caps unnoticed | L0 + D4 |
| 4 | Vague NL produces intent plan + first-move guidance on interactive | E1–E3 |
| 5 | Two consecutive capped A08 smokes: patch **or** early-BLOCK with rich artifacts — never silent empty thrash | D4 + optional D4b |
| 6 | Selective remeasure ≥ baseline honesty (infra fails labeled) | F1 |

**Numeric targets** (carry forward from gap plan):

| Metric | Target |
|--------|--------|
| `tools_before_first_write` (median, single-file SWE) | ≤ 8 |
| Zero-write runs past hard-stop | 0 |
| Fail payloads with empty `toolCalls` when tools ran | 0 |
| Operator time to diagnose fail | < 5 minutes |
| Smoke cost | ≤ $0.75, ≤ 40 turns (prefer hard-stop ≪ 40) |

---

## 4. Shipped inventory (do not re-do)

### 4.1 Layer 0 — Control honesty

| ID | Item | Location |
|----|------|----------|
| L0.1 | Phase verify only after writes | `stallDetector.ts`, `chatPhaseNudge.ts` |
| L0.2 | `mutate_only` restrict tools | `chatToolDefinitions.ts`, `chatZeroWritePolicy.ts` |
| L0.3 | Zero-write hard stop | `chatTaskClass.ts`, `budgetKillPolicy.ts` |
| L0.4 | Shell counts in exploration fuse (zero writes) | `readThrashPolicy.ts` |
| L0.5 | Stream failed exports `toolCalls` | `chatEngine.ts`, `chatEventDispatch.ts` |

### 4.2 Tier A — See the run

| ID | Module / surface |
|----|------------------|
| A1 | `toolCallExport.ts` + aggregates |
| A2 | `policyEventLog.ts` + jsonl |
| A3 | `turnRoutingReceipt.ts` |
| A4 | `patch_reality` in chatCore + harness |
| A5 | `observationTails.ts` |
| A6 | harness `run_dir` / paths / card paths |

### 4.3 Tier B — See the mind

| ID | Module |
|----|--------|
| B1 | `thoughtCapture.ts` (opt-in) |
| B2 | `turnSummaryScheduler.ts` |
| B3 | `blockedAttemptLedger.ts` |
| B4 | `promptFingerprint.ts` |

### 4.4 Tier C — Peer NL UX modules

| ID | Module |
|----|--------|
| C1 | `intentCompiler.ts` + `intent_plan.json` |
| C2 | `firstMoveCard.ts` + `tools_before_first_write` |
| C3 | `failureCard.ts` → `FAILURE_CARD.md` / `SUCCESS_CARD.md` |

### 4.5 Factory campaign receipts

| Campaign | Status | Cost |
|----------|--------|------|
| `plans/factory/campaigns/20260712-230058-tier-b` | passed | ~$19.31 |
| `plans/factory/campaigns/20260712-235904-tier-c` | passed | ~$9.51 |
| `smoke-phase3-tier-a` | **smoke only** — not product proof | n/a |

---

## 5. Residual root causes (post-ship)

| ID | Severity | Residual | Addressed in |
|----|----------|----------|--------------|
| RC1–RC5 | — | Closed by L0 | — |
| RC6 Intent | Low | Modules shipped; defaults/product on-path need E | E1–E3 |
| RC7 Env asymmetry | Medium | Windows matplotlib/pytest still rabbit-hole risk | D2 policy + F2 later |
| RC8 Routing | Low | Receipts exist; interactive Flash/Pro parity incomplete | E2 |
| RC9 Playbook conflict | Medium | Policy hard-stops; prompt can still push early pytest | **D2** |
| RC10 Surface fragmentation | Medium | chat / headless / SWE matrix undocumented as one profile | **D3 + E1** |

---

## 6. Tier map (execution order)

```text
Tier D — Validate & align          ← START HERE (factory campaign)
Tier E — Product peer-CLI UX    ← user must start explicitly
Tier F — Eval truth + remeasure ← user must start explicitly
```

Do **not** reorder: live multi-cell without D wastes money; product polish without D cannot validate honesty.

---

## 7. Tier D — Validate & align (factory campaign)

**Goal**: Offline schema green + playbook alignment + operator guide + **one** live capped smoke.  
**Budget suggestion**: $40 campaign / $12 per slice (D4 may use live API).  
**Mode**: sequential; `stop_on_hard: true`; **do not start Tier E**.

### D1. Offline observability acceptance suite

**Problem**: Units exist per module, but there is no single offline gate that asserts the **harness-facing contract** operators rely on after a fail.

**Design**

- Golden fixture(s) or pure builders that produce a minimal `ChatResult` / harness-shaped object with:
  - `observability_schema_version: 1`
  - non-empty `toolCalls` when tools ran
  - `policy_events` including at least one thrash-related kind under zero-write sim
  - `patch_reality.empty_patch` true when no writes
  - `tools_before_first_write` defined
  - failure/success card markdown non-empty
- Script or test entry: `npm test` subset or `npx tsx --test` list documented in this section.

**Implementation steps**

1. Add `observabilityAcceptance.test.ts` (or extend harness tests) covering schema fields above.  
2. Document exact command in §11 verification matrix.  
3. Do **not** require live API.

**Files**

- `babel-cli/src/services/agentBenchmarkHarness.test.ts`
- `babel-cli/src/interactive/execution/chatCore.budgetPayload.test.ts`
- `babel-cli/src/agent/failureCard.test.ts` (golden only if needed)
- Prefer new pure test helpers over growing `chatEngine.ts`

**Acceptance**

- [ ] Offline test fails if `toolCalls` omitted on a simulated tools-ran fail payload  
- [ ] Offline test asserts `patch_reality` + `policy_events` shape  
- [ ] `npx tsc --noEmit` green  

**Effort**: S–M  
**Depends on**: nothing  
**Live API**: No  

---

### D2. Playbook / prompt thrash alignment (RC9)

**Problem**: Policy forces mutate-before-shell thrash; playbook `verify` still emphasizes pytest early enough that models race the env before patching.

**Design**

- Single explicit rule for `general_swe` / single-file playbook:
  1. Localize (≤ few reads/greps)  
  2. **One** `str_replace`  
  3. **Then** targeted pytest  
  4. If env red: report patch-ready / BLOCKED — **do not** 40-turn install/shell thrash  
- Align multi-file similarly (plan → mutate → verify per file).  
- Remove language that implies full-suite or early shell-as-strategy.

**Implementation steps**

1. Edit `single-file.json` (+ multi-file if needed) phaseGuidance.  
2. Add/adjust playbookService tests for “patch before broad pytest” keywords.  
3. Grep agent system/playbook injection for contradictory “run tests first” strings on execute classes.

**Files**

- `babel-cli/src/services/playbooks/single-file.json`
- `babel-cli/src/services/playbooks/multi-file.json`
- `babel-cli/src/services/playbooks/playbookService.test.ts`
- Optional: prompt snippets only if they override playbook (minimize scope)

**Acceptance**

- [ ] Single-file playbook text requires mutate before full/env-fighting pytest loops  
- [ ] Unit test locks the rule (string or structured field)  
- [ ] No new cell-specific knobs  

**Effort**: S  
**Depends on**: nothing (can parallel D1 only if allow-lists disjoint — default sequential)  
**Live API**: No  

---

### D3. Operator guide + coding profile doc

**Problem**: Peer CLIs feel transparent; Babel still requires tribal knowledge to open `runs/` and harness JSON.

**Design**

Short operator doc (or plan § expand → `docs/guides/`):

1. How to read a failed cell (paths, fields, card)  
2. **Coding agent profile** defaults: task class, hard-stop, force-mutate, intent compiler, observation tails  
3. Env cheat sheet: `BABEL_CHAT_*` flags that matter (no secrets)

**Implementation steps**

1. Author `docs/guides/CHAT_RUN_EVIDENCE_AND_CODING_PROFILE.md` (or equivalent).  
2. Link from companion observability plan §9 + this roadmap.  
3. Keep under ~200 lines; tables over prose.

**Files**

- `docs/guides/CHAT_RUN_EVIDENCE_AND_CODING_PROFILE.md` (new)
- `docs/plans/BABEL_RUN_OBSERVABILITY_AND_NL_UX_PLAN_2026-07-12.md` (pointer only)
- `docs/plans/README.md` (index line)

**Acceptance**

- [ ] Cold reader can open a harness JSON + card without reading chatEngine  
- [ ] Coding profile table lists defaults for interactive vs headless/SWE  
- [ ] No secrets / no API keys  

**Effort**: S  
**Depends on**: D1 field names stable (soft)  
**Live API**: No  

---

### D4. Capped A08 live smoke + evidence attach

**Problem**: Without one live cell, we cannot claim peer-CLI process under real model + Windows env.

**Design**

- Rebuild `dist` first (`ensureBabelCliDistReady` / `npm run build`).  
- Cap: `BABEL_CHAT_MAX_COST=0.75`, `BABEL_CHAT_MAX_TURNS=40` (hard-stop should fire earlier if thrash).  
- One cell: SWE-A08 (or A01 if dataset path forces).  
- **Pass criteria** (either branch):
  - **Patch branch**: non-empty `patch_reality` / git patch; card present  
  - **Honest fail branch**: early BLOCKED / hard-stop; **non-empty** `toolCalls` + `policy_events`; `FAILURE_CARD.md` exists  
- **Fail criteria**: 40-turn empty thrash with empty tool log, or silent death without card  

**Implementation steps**

1. `cd babel-cli && npm run build`  
2. Run remeasure/smoke script for single task with caps  
3. Copy or link harness JSON + card paths into handoff or `docs/audit/` evidence note  
4. Record metrics: turns, cost, `tools_before_first_write`, hard-stop fired?

**Files**

- Evidence under `runs/` / harness evidence dir (generated)  
- Optional: `docs/audit/BABEL_A08_SMOKE_POST_ABC_2026-07-13.md` (short receipt)  
- No production code changes unless smoke reveals HARD bug → stop campaign, open repair slice  

**Acceptance**

- [ ] Smoke completed under caps  
- [ ] Artifact bundle complete on terminal status  
- [ ] Verdict written: PATCH | EARLY_BLOCK_RICH | REGRESSION  
- [ ] If REGRESSION: file bug list; do **not** expand to multi-cell  

**Effort**: S (ops) + live $  
**Depends on**: D1, D2 recommended; D3 soft  
**Live API**: **Yes (one cell)**  

---

### Tier D exit gate

| Gate | Check |
|------|--------|
| Typecheck | `cd babel-cli; npx tsc --noEmit` |
| Build | `cd babel-cli; npm run build` |
| Budget | `pwsh tools/check-architectural-budget.ps1` |
| Offline acceptance | D1 test command green |
| Live | D4 smoke = PATCH or EARLY_BLOCK_RICH |
| Docs | D3 guide present and linked |

**Stop.** Do not start Tier E without user.

---

## 8. Tier E — Product peer-CLI UX

**Goal**: Interactive defaults feel like Grok/Claude Code without harness archaeology.  
**Start only after Tier D exit gate.**

### E1. Coding profile runtime defaults

**Problem**: Defaults differ across chat / headless / SWE; operators cannot predict behavior.

**Design**

- Single documented **coding profile** applied when intent is execute/fix:
  - task class resolution  
  - zero-write hard-stop on  
  - intent compiler on (interactive)  
  - first-move / playbook headers when tests known  
  - observation tails on terminal export  
- Prefer env + task-class tables over new modes.

**Files**

- `babel-cli/src/config/chatTaskClass.ts`
- `babel-cli/src/utils/envFlags.ts`
- `docs/guides/CHAT_RUN_EVIDENCE_AND_CODING_PROFILE.md` (sync)

**Acceptance**

- [ ] Table of defaults matches runtime  
- [ ] Unit tests for key flags  
- [ ] No new pipeline modes  

**Effort**: M  
**Depends on**: D3  
**Live API**: No  

---

### E2. Interactive Flash/Pro phase routing parity

**Problem**: Harness benefits from investigate/mutate model split; interactive may still burn Pro on explore.

**Design**

- Reuse `BABEL_CHAT_INVESTIGATE_MODEL` / `MUTATE_MODEL` (or existing equivalents) on interactive execute path.  
- Routing receipts (A3) must populate in interactive the same as headless.  

**Files**

- `babel-cli/src/agent/chatEngine.ts` (minimal wire)  
- routing / model selection helpers (prefer extract)  
- tests for receipt + model choice  

**Acceptance**

- [ ] Interactive multi-turn mock: investigate model ≠ mutate model when configured  
- [ ] Receipts exported on payload  

**Effort**: M  
**Depends on**: E1 soft  
**Live API**: Prefer offline mock  

---

### E3. Intent compiler + first-move on interactive default path

**Problem**: C1/C2 modules may be SWE/headless-biased; vague interactive “fix the login bug” must expand intent first.

**Design**

- Default `BABEL_CHAT_INTENT_COMPILER=1` for interactive execute (not investigate).  
- Skip or dataset-path when FAIL_TO_PASS present.  
- First-move card / repo preflight for local projects with tests.

**Files**

- `babel-cli/src/agent/intentCompiler.ts`  
- `babel-cli/src/agent/firstMoveCard.ts`  
- `babel-cli/src/interactive/execution/chatCore.ts`  
- tests  

**Acceptance**

- [ ] Vague fixture → `intent_plan.json` written  
- [ ] SWE-with-known-test → no invented test path  
- [ ] Interactive smoke (optional, offline preferred)  

**Effort**: S–M  
**Depends on**: E1  
**Live API**: Optional  

---

### E4. (Stretch) Vague-mode product polish

**Problem**: Multi-file signals, cost soft-confirm, todo-before-mutate still uneven.

**Design** (from prior C4 stretch)

- Vague “fix X” → `default`/`quick_fix`, not `investigate`  
- `requireTodoBeforeMutate` only on multi-file signals  
- Soft TTY confirm when projected cost > $0.50 (interactive only)

**Files**

- task classification / chatCore preflight  
- TUI confirm only if already have pattern  

**Acceptance**

- [ ] Classification tests for vague vs investigate  
- [ ] No headless confirm blocking CI  

**Effort**: M  
**Depends on**: E1–E3  
**Live API**: No  

### Tier E exit gate

| Gate | Check |
|------|--------|
| Units for E1–E3 | green |
| Typecheck + build + budget | green |
| Interactive offline smoke | intent plan + receipts present |
| Docs sync | coding profile matches runtime |

**Stop.** Tier F requires user.

---

## 9. Tier F — Eval truth & selective remeasure

### F1. Selective remeasure (2–3 cells)

**Problem**: Pass-rate claims need post-ABC evidence without full suite waste.

**Design**

- Cells: A08 + one historically hard + one easy (or A01/A03/A09 slice from CHAT_HARNESS roadmap).  
- Same honesty criteria as CHAT_HARNESS P5 slice.  
- Cap cost per cell; stop if thrash regression.

**Acceptance**

- [ ] Every cell: card + toolCalls + policy_events + patch_reality  
- [ ] Infra fails labeled separately from model fails  
- [ ] Correct rate vs baseline noted; no marketing spin  

**Effort**: ops  
**Live API**: Yes  
**Depends on**: Tier D exit; prefer Tier E for interactive claims  

---

### F2. Docker / Linux SWE eval path

**Problem**: Windows host pytest is not authoritative for many SWE cells (RC7).

**Design**

- Follow CHAT_HARNESS P4.1: containerized verifier optional path.  
- Keep gold_diff as secondary signal, not sole truth when docker available.

**Effort**: L  
**Live API**: Yes (infra)  
**Depends on**: F1 decision that Windows scoring blocks trust  

---

### F3. Baseline refresh process

**Problem**: Stale baselines demoralize and misguide.

**Design**

- Document when/how to refresh T1.4 (or successor) after green selective remeasure.  
- Require: build gate, critic receipts, observability schema present.

**Effort**: S  
**Depends on**: F1 green  

### Tier F exit gate

| Gate | Check |
|------|--------|
| F1 metrics held | yes/no decision recorded |
| Full SWE-A | **only if** F1 holds — separate explicit campaign |
| Baseline doc | updated or “no refresh” reason |

---

## 10. Work packages (factory sequencing)

```text
WP-D1  Offline observability acceptance     [D1]
WP-D2  Playbook thrash alignment            [D2]
WP-D3  Operator guide + coding profile doc  [D3]
WP-D4  Capped A08 live smoke + receipt      [D4]
       ── Tier D exit gate ── stop
WP-E1  Coding profile runtime defaults      [E1]
WP-E2  Interactive Flash/Pro routing        [E2]
WP-E3  Intent/first-move interactive path   [E3]
WP-E4  Vague-mode stretch (optional)        [E4]
       ── Tier E exit gate ── stop
WP-F1  Selective 2–3 cell remeasure         [F1]
WP-F2  Docker eval (if needed)              [F2]
WP-F3  Baseline refresh                     [F3]
```

| WP | Parallel? | Live API? |
|----|-----------|-----------|
| D1–D3 | Yes if disjoint allow-lists; default sequential | No |
| D4 | No | Yes, one cell |
| E1–E3 | Sequential preferred (`chatEngine` / chatCore hotspots) | Prefer offline |
| F1 | No | Yes |

**Parallel fan-out rule**: never two agents edit `chatEngine.ts` or `chatCore.ts` concurrently.

---

## 11. Verification matrix

| Layer | Command |
|-------|---------|
| Units (targeted) | `cd babel-cli && npx tsx --test src/agent/chatZeroWritePolicy.test.ts src/agent/policyEventLog.test.ts src/agent/toolCallExport.test.ts src/agent/failureCard.test.ts src/agent/intentCompiler.test.ts src/services/agentBenchmarkHarness.test.ts` (+ D1 suite when added) |
| Typecheck | `cd babel-cli && npx tsc --noEmit` |
| Build | `cd babel-cli && npm run build` |
| Budget | `pwsh tools/check-architectural-budget.ps1` |
| Caps smoke | `BABEL_CHAT_MAX_COST=0.75` `BABEL_CHAT_MAX_TURNS=40` + single-task remeasure (D4) |
| Full suite | Deferred until F1 decision |

---

## 12. Factory usage

### Tier D campaign (recommended next)

```powershell
# After curated board JSON is available:
pwsh -NoProfile -File "$env:USERPROFILE\.config\agent\skills\factory\scripts\init-factory-board.ps1" `
  -RepoRoot "./" `
  -BoardJson "/user-home/.config/agent/skills/factory/references/babel-tier-d-board.json" `
  -PlanPath "./docs/plans/BABEL_PEER_CLI_PARITY_NEXT_ROADMAP_2026-07-13.md" `
  -Tier D `
  -BudgetUsd 40 `
  -Goal "Tier D validate & align (post A/B/C)"
```

Or:

```text
/factory campaign docs/plans/BABEL_PEER_CLI_PARITY_NEXT_ROADMAP_2026-07-13.md tier D budget 40
```

### Rules

1. One slice at a time (sequential).  
2. L3 repair ≤3 rounds per slice.  
3. Exit gate → **stop**.  
4. User must explicitly start Tier E or F.  
5. D4 live smoke: confirm API key + dataset path before spawn.

---

## 13. Risks if we skip Tier D

| Risk | Cost |
|------|------|
| Ship A/B/C without live proof | False confidence; peer demos fail |
| Multi-cell burn pre-smoke | $ + thrash regressions invisible |
| Product polish without playbook align | Model fights policy (RC9) |
| Full suite before selective F1 | Wrong roadmap from noisy cells |

---

## 14. Success criteria (roadmap complete)

This roadmap is **done** when:

1. Tier D exit gate green (offline + docs + one rich smoke).  
2. Tier E exit gate green **or** explicitly deferred with reason.  
3. F1 selective remeasure recorded with honesty metrics.  
4. Gap plan + observability plan marked shipped for L0–C; this doc remains ACTIVE until F1 decision.

---

## 15. Related documents

| Doc | Role |
|-----|------|
| BABEL_VS_GROK_CLI_GAP_AND_FIX_PLAN_2026-07-12.md (vault-only) | Why we lagged; layers 0–3 (**shipped**) |
| BABEL_RUN_OBSERVABILITY_AND_NL_UX_PLAN_2026-07-12.md (vault-only) | A/B/C implementation detail (**campaigns passed**) |
| CHAT_HARNESS_ROADMAP_2026-07-12.md (vault-only) | Pass-rate P0–P5; F1 aligns with P5 slice |
| BABEL_PAST_RUNS_INVESTIGATION_2026-07-12.md (vault-only) | Historical cell ledger |
| Factory boards | `plans/factory/campaigns/20260712-*-tier-{b,c}/` |

---

## 16. Immediate next actions

1. **Start Tier D factory campaign** (D1→D4 sequential).  
2. Do **not** open multi-cell live remeasure.  
3. After D4: attach smoke evidence; decide PATCH vs EARLY_BLOCK_RICH vs REGRESSION.  
4. Only then: user may start **Tier E** or jump to **F1** if interactive polish is deferred.
