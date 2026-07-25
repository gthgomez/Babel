<!-- License: MIT — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-07-16
role: CANONICAL_GROK_UPGRADE
purpose: Dated Babel CLI vs Grok CLI audit + ordered implementation plan to upgrade Babel toward Grok-class agency while preserving Babel governance/evidence moats
-->

# Babel vs Grok CLI — Upgrade Audit & Implementation Plan

**Date:** 2026-07-16  
**Status:** **ACTIVE / CANONICAL** for Grok-class product upgrade of Babel CLI  
**Branch context:** `the Grok comparison feature branch` (W3.3 scorecard landed)  
**Grok reference:** Grok Build **0.2.101** (`~/.config/agent/`, user guide + live harness)  
**Babel reference:** `babel-cli/src/agent/*`, task-class policy, TUI competitive ref ~8.5/10  

### How to use this document

| Need | Section |
|------|---------|
| One-screen verdict | [§1](#1-executive-verdict) |
| Fair comparison frame | [§2](#2-comparison-frame) |
| What already shipped (do not re-build) | [§3](#3-shipped-inventory-do-not-rebuild) |
| Where Babel still lags / leads | [§4](#4-position-by-area) |
| Agent-performance model (how an agent behaves in each harness) | [§5](#5-agent-performance-model) |
| **Ordered implementation plan** | [§6](#6-implementation-plan-upgrade-waves) |
| Definition of done / metrics | [§7](#7-definition-of-done--metrics) |
| File map | [§8](#8-file-map) |
| Tracking table (edit as PRs land) | [§9](#9-tracking-table) |
| Factory / PR packaging | [§10](#10-factory--pr-packaging) |

### Relationship to other docs

| Doc | Role relative to this audit |
|-----|------------------------------|
| BABEL_VS_GROK_CLI_GAP_AND_FIX_PLAN_2026-07-12.md | **Diagnosis** L0–C shipped — do not re-implement A1–C3 |
| [BABEL_PEER_CLI_PARITY_NEXT_ROADMAP_2026-07-13.md](../plans/BABEL_PEER_CLI_PARITY_NEXT_ROADMAP_2026-07-13.md) | Peer-CLI validate path (Tier D→E→F) — **absorbed into Wave U0–U1** below where overlapping |
| [CLAUDE_CODE_VS_BABEL_GAP_ANALYSIS_2026-07-13.md](./CLAUDE_CODE_VS_BABEL_GAP_ANALYSIS_2026-07-13.md) | Structural phase-gate lessons — still valid for policy defaults |
| [BABEL_CODING_AGENT_STATE_2026-07-08.md](./BABEL_CODING_AGENT_STATE_2026-07-08.md) | Harness residual inventory (SWE quality, etc.) |
| IMPLEMENTOR_ROADMAP_W0_W1_PROGRESS_2026-07-15.md | W0–W3 implementor progress — **preconditions green for this upgrade** |
| babel-cli/docs/TUI_COMPETITIVE_REFERENCE.md | TUI matrix only — not the agent-loop upgrade path |

**Supersedes for planning:** ad-hoc “copy Grok” brainstorms without file targets.  
**Does not supersede:** claims matrix rules, public-export gates, or V9 orchestrator contracts.

---

## 1. Executive verdict

### Product formula (target)

```
Grok-class interactive agency          (model owns tool sequence)
  + Claude/Grok plan & permission UX   (plan approve, accept-edits, yolo with deny)
  + Babel Prompt OS + deep governance  (on demand, not default daily path)
  + Babel evidence / claims honesty    (cards, policy events, cost ledger)
  + Multi-model cost control           (Flash investigate / Pro mutate)
```

### One-line verdict

**Grok is the better daily coding peer today. Babel is the better governed coding system.** The upgrade is **Grok-feel defaults + Babel depth on demand** — not more phase machinery and not deleting governance.

### Policy principle (lock this)

> **Governance must observe and grade; it must not invent a second agent that outvotes the model’s tool choices on ordinary coding tasks.**

| Use hard gates for | Use soft nudges for |
|--------------------|---------------------|
| Secrets | Thrash / shell-before-patch |
| Destructive ops | Long investigate |
| `governance` task class | Flash/Pro hints |
| Completion honesty (empty patch, false complete) | Cost awareness |

### Confidence

| Layer | Confidence |
|-------|------------|
| Babel agent/policy architecture (source) | **High** |
| Grok product surfaces (docs + live harness) | **High** |
| Historical thrash root causes (pre L0–C) | **High** |
| Live peer-CLI feel parity *today* | **Medium** — modules shipped; dual live validation incomplete |
| Effort estimates in §6 | **Medium** |

---

## 2. Comparison frame

### 2.1 Product identity

| | **Grok CLI (Build 0.2.101)** | **Babel CLI** |
|--|------------------------------|---------------|
| Identity | Terminal coding agent + ACP server | Coding agent **+** Prompt OS **+** optional governed pipeline |
| Primary loop | Single model, free tool loop | `ChatEngine` **or** deep `PLAN → QA → ACT` |
| Default success | Diff the operator accepts | Diff + verifier/evidence (+ claims gates) |
| Distribution | Closed binary | Open product lab + public export |
| Model default | Grok family (strong + tools) | Multi-backend waterfall (DeepSeek/DeepInfra common) |

### 2.2 Architecture

```
Grok CLI
  User → TUI / headless / ACP
       → single agent loop
       → tools (files, shell, web, MCP, subagents, plan, media…)
       → permission modes + optional OS sandbox
       → ~/.config/agent/sessions

Babel CLI
  User → TUI / one-shot / deep / lite
       ├─ chat: ChatEngine (tools + policy fuses + critic + gates)
       └─ deep: Orchestrator → domain agents → QA → executor
       → tools + MCP + sub_agent (+ implement worktree)
       → runs/, cost ledger, policy events, failure cards
       → Prompt OS layers
```

### 2.3 Control philosophy

| Axis | Grok | Babel (2026-07-16) |
|------|------|---------------------|
| Who sequences tools? | **Model** | Model + task-class policy (soft-first on execute classes) |
| Write timing | Permission-allowed anytime | Plan-gate / phase-gate optional; execute classes mostly open |
| Completion | Model says done | Completion gate may demand verifier / honesty labels |
| Failure story | Transcript in UI | Transcript + tool export + policy JSONL + cards + cost |
| Ambiguity | Plan mode (read-only except plan file) | Plan mode / hard-plan / deep pipeline / playbooks |

### 2.4 Capability matrix (operator-visible)

Legend: **✓** strong · **△** partial · **✗** weak/absent

| Capability | Grok | Babel | Upgrade wave |
|------------|------|-------|--------------|
| Interactive TUI | ✓ | ✓ | — (optional polish only) |
| Headless / CI scripting | ✓ | △ | **U2** |
| IDE protocol (ACP) | ✓ | ✗ | **U5** (later) |
| Localize → edit → verify | ✓ | △ | **U0–U1** |
| File tools | ✓ | ✓ | — |
| Shell + background | ✓ | ✓ | — |
| Subagents + worktrees | ✓ | △ | **U3** |
| Plan approve UI | ✓ | △ | **U2** |
| Skills multi-host discovery | ✓ | △ | **U3** |
| Project rules | ✓ | ✓ | — |
| MCP | ✓ | ✓ | **U3** polish |
| Permission modes | ✓ | △ | **U2** (thicken W1.4) |
| OS sandbox product UX | ✓ | △ | **U4** |
| Web search/fetch | ✓ | △ | **U4** optional |
| Media / X tools | ✓ | ✗ | **Out of scope** (plugins only) |
| Multi-model cost routing | △ | ✓ | **U1** (surface in TUI) |
| Deep governance pipeline | ✗ | ✓ | Preserve (on-demand) |
| Evidence / claims / cost | △ | ✓ | **U0–U1** (default visibility) |
| Grok-shadow scorecard | — | ✓ offline | **U0** live dual-run |
| Local offline models | △ | ✗ | **U5** / preservation |

### 2.5 Fair axes only (do not blame)

| Do compare | Do not blame on “model dumb only” |
|------------|-----------------------------------|
| Control loop honesty | Marketing claims without cells |
| Tool timeline visibility | TUI easter eggs |
| Interactive defaults | Unrelated deep-mode rewrites |
| Prompt/policy alignment | Full SWE-A burn before validation |
| Product surface fragmentation | Closed-source Grok internals we cannot copy |

---

## 3. Shipped inventory (do not rebuild)

### 3.1 Grok-gap layers L0–C (2026-07-12/13)

| Layer | Status | Evidence |
|-------|--------|----------|
| L0 thrash control | **Shipped** | verify-after-writes, `mutate_only`, hard-stop knobs, shell-in-fuse, failed tool export |
| Tier A observability | **Shipped** | toolCallExport, policyEventLog, routing receipts, patch_reality, observation tails |
| Tier B mind/decisions | **Shipped** | thoughtCapture, turnSummary, blockedAttemptLedger, promptFingerprint |
| Tier C NL UX modules | **Shipped** | intentCompiler, firstMoveCard, failureCard |

### 3.2 Implementor W0–W3 (through 2026-07-16)

| Wave | Status | Notes |
|------|--------|-------|
| W0 async cancel, TurnRuntime, env-red, smoke validation | **Done** | Offline hard cells + TTF baseline |
| W1 shell soft budget, hard-plan, operator modes (thin), metric gate | **Done** | `/mode`, `/execute-plan`, `/why-stopped` |
| W2 implement worktree agent, explore feeder, review-on-diff | **Done (core)** | Auto-merge deferred |
| W3 secret scan, evidence PR body, **Grok-shadow scorecard** | **Done** | `implementorScorecard.ts` offline |

### 3.3 Policy posture already converging on Grok

From `chatTaskClass.ts` + tests (verify before changing):

| Knob | `default` / `quick_fix` | `general_swe` | `governance` |
|------|--------------------------|---------------|--------------|
| `phaseGatedToolsDefault` | false | false (unless class sets true — re-verify) | true |
| `restrictToolsOnPolicyFire` | soft-nudge design | soft on execute | hard restrict OK |
| `zeroWriteHardStopTurns` | 12 / 8 | **0** (shadow only) | 10 |

**Rule for implementors:** do not re-introduce hard tool restriction on execute classes without a dual-run regression against Grok-shadow scorecard + live cell.

### 3.4 TUI

Phases A–E + residual G1–G7 **complete**. Do not schedule autocomplete/dialogs/keymap as missing. Optional O1–O6 only in TUI corrected plan.

---

## 4. Position by area

| Area | Verdict | Leader | Upgrade? |
|------|---------|--------|----------|
| Daily interactive coding agency | **VULNERABLE** (improving) | Grok | **Yes — U0–U2** |
| TUI polish | **MIXED / near parity** | ≈ | Optional only |
| Plan / permissions / IDE | **VULNERABLE** | Grok | **Yes — U2, U5** |
| Skills ecosystem | **MIXED** | Grok discovery | **U3** |
| Governance / multi-agent contracts | **WIN** | Babel | Preserve |
| Evidence / cost / claims | **WIN** | Babel | Default visibility |
| Multi-model economics | **WIN** | Babel | Surface in UI |
| Subagent mutation at scale | **VULNERABLE** | Grok | **U3** |
| Enterprise audit | **WIN** | Babel | Preserve |
| Adjacent non-code tools | **VULNERABLE** | Grok | Out of core scope |
| Open harness ownership | **WIN** | Babel | Preserve |

---

## 5. Agent performance model

How a capable coding agent behaves in each harness on the same tasks.

### 5.1 Localized bug fix

| Step | Grok | Babel (target after U1) |
|------|------|-------------------------|
| 1–3 | grep/read (parallel OK) | same |
| 4 | `search_replace` | `str_replace` |
| 5 | targeted test | targeted test **after** patch |
| Failure | transcript | transcript + card + policy events |

**Target metrics:** median `tools_before_first_write` ≤ 8 (Grok-class ≤ 5). Never silent empty thrash.

### 5.2 High-ambiguity design

| | Grok | Babel |
|--|------|-------|
| Best path | Plan mode → approve → implement | hard-plan / plan mode → `/execute-plan` → implement |
| After U2 | Same mental model: approve plan UI | Scrollable plan approve / request changes |

### 5.3 Enterprise / audit

Babel remains preferred: cost ledger, claims matrix, deep QA reject proof, secret scan. Grok investigates freely but does not force evidence bundles.

### 5.4 Failure modes to eliminate in Babel

| Historical failure | Status | Upgrade residual |
|--------------------|--------|------------------|
| Shell thrash as “progress” | Fixed L0 | Validate live U0 |
| Force-mutate left shell open | Fixed L0 | Keep tests |
| Zero-write 40-turn burn | Fixed / disabled per class | Shadow scorecard + live |
| Phase-gate deadlock | Fixed | Keep phase-gate **off** for execute |
| Mixed playbook vs policy | Partial D2 | **U0.2** |
| Tool timeline only in harness | Modules exist | **U1.1** TUI default |

---

## 6. Implementation plan (upgrade waves)

### Wave map

```text
U0  Validate & align          ← START (offline + one live dual-run)
U1  Interactive peer defaults (coding profile productized)
U2  Plan / permissions / headless DX
U3  Subagents + skills discovery
U4  Sandbox + optional web depth
U5  ACP / IDE + local models (strategic, later)
```

**Rules:**
1. Do not start U2 product polish until **U0 exit gate** passes.  
2. Do not re-implement L0–C or W0–W3 modules.  
3. Each work item: smallest correct change; unit-test first; live only where labeled.  
4. Deep mode stays **opt-in** high-stakes path — never the default for “fix the login bug.”

---

### Wave U0 — Validate & align (gate for everything else)

**Goal:** Validate honesty of the shipped stack; align playbook; freeze upgrade baseline.  
**Budget:** prefer offline; one live smoke ≤ $0.75 / ≤ 40 turns.  
**Maps from:** Peer Tier D1–D4 + Grok dual-run.

#### U0.1 Offline observability + Grok-shadow gate

| Field | Value |
|-------|-------|
| **Problem** | Modules exist; no single “upgrade baseline green” command operators run before product work |
| **Design** | (1) Observability acceptance suite (non-empty toolCalls on fail, policy_events, patch_reality, cards). (2) `babel evidence scorecard` / implementor Grok-shadow **must pass** offline |
| **Files** | `babel-cli/src/agent/observabilityAcceptance.test.ts` (or existing), `implementorScorecard.ts`, `evidenceProductCommands.ts` |
| **Acceptance** | [ ] Offline suite green · [ ] Scorecard PASS · [ ] Documented one-liner in this §9 |
| **Effort** | S–M |
| **Live API** | No |

#### U0.2 Playbook ↔ policy alignment (RC9)

| Field | Value |
|-------|-------|
| **Problem** | Prompt/playbook can still push env-pytest before patch |
| **Design** | Single rule: localize → **one** `str_replace` → targeted pytest → if env red: patch-ready / ENV_BLOCKED, no install thrash |
| **Files** | `babel-cli/src/services/playbooks/single-file.json`, `multi-file.json`, `playbookService.test.ts` |
| **Acceptance** | [ ] Unit locks “mutate before env-fighting pytest” · [ ] No cell-specific knobs |
| **Effort** | S |
| **Live API** | No |

#### U0.3 Operator evidence guide freeze

| Field | Value |
|-------|-------|
| **Problem** | Peer CLIs feel transparent; Babel still tribal for `runs/` |
| **Design** | Keep/refresh `docs/guides/CHAT_RUN_EVIDENCE_AND_CODING_PROFILE.md` with coding-profile defaults table linked from this audit |
| **Files** | `docs/guides/CHAT_RUN_EVIDENCE_AND_CODING_PROFILE.md`, this audit §8 |
| **Acceptance** | [ ] Cold reader diagnoses a fail < 5 min using guide only |
| **Effort** | S |
| **Live API** | No |

#### U0.4 Live capped dual-run (Babel + optional Grok shadow narrative)

| Field | Value |
|-------|-------|
| **Problem** | Peer-CLI parity unproven live |
| **Design** | One single-file bug cell (A08-class or fixture). Capture: tools_before_first_write, write_rate, empty_patch honesty, toolCalls non-empty, failure/success card, policy_events. Write `docs/status/BABEL_GROK_DUAL_RUN_YYYY-MM-DD.md` |
| **Files** | harness scripts, `runs/…`, status note |
| **Acceptance** | [ ] Patch **or** early BLOCKED with rich artifacts · [ ] Never silent thrash · [ ] Cost ≤ $0.75 |
| **Effort** | M |
| **Live API** | Yes |

**U0 exit gate (all required):**

- [x] U0.1 offline green  
- [x] U0.2 playbook rule locked  
- [x] U0.3 guide current  
- [x] U0.4 live smoke honesty (patch or early BLOCKED)  

---

### Wave U1 — Interactive peer defaults (product coding profile)

**Goal:** Default interactive chat feels Grok-class without reading env var folklore.  
**Maps from:** Peer Tier E + implementor coding profile.

#### U1.1 Tool timeline + cards as default TUI surface

| Field | Value |
|-------|-------|
| **Problem** | Artifacts on disk; operators still miss them in-session |
| **Design** | On fail/success: show failure/success card summary + last N tools in transcript/status (not only under runs/) |
| **Files** | `babel-cli/src/ui/*` renderer paths, `failureCard.ts`, chat event dispatch |
| **Acceptance** | [ ] Interactive fail shows card path + non-empty tool summary without opening JSON · [ ] Unit/snapshot tests |
| **Effort** | M |
| **Depends** | U0 exit |

#### U1.2 Coding profile defaults (product, not env soup)

| Field | Value |
|-------|-------|
| **Problem** | Peer feel requires correct env/task class |
| **Design** | Single **coding profile** for interactive: execute-class soft fuses, intent compiler on for vague NL, first-move card on, phase-gate off, Flash/Pro status if multi-model enabled |
| **Files** | `chatTaskClass.ts`, interactive bootstrap, `docs/guides/CHAT_RUN_EVIDENCE_AND_CODING_PROFILE.md` |
| **Acceptance** | [ ] Fresh REPL, no env vars: single-file fix path follows localize→edit→verify · [ ] Doc table matches code |
| **Effort** | M |
| **Depends** | U0.2 |

#### U1.3 Flash/Pro (or cheap/strong) visible in status bar

| Field | Value |
|-------|-------|
| **Problem** | Multi-model moat invisible |
| **Design** | Status bar shows active model tier + last routing receipt (short) |
| **Files** | `tokenBar` / status bar, `turnRoutingReceipt.ts` bridge |
| **Acceptance** | [ ] Operator sees model switch without opening logs |
| **Effort** | S–M |
| **Depends** | U1.2 optional parallel |

#### U1.4 Prompt stack slim for interactive chat

| Field | Value |
|-------|-------|
| **Problem** | Large SWE/playbook prompts create mixed signals vs Grok thin prompts |
| **Design** | Interactive chat loads **minimal** stack; full SWE playbook only when task-class = general_swe or explicit `/playbook` |
| **Files** | `chatStackCompile.ts`, playbook inject sites, tests |
| **Acceptance** | [ ] Default interactive system prompt token budget documented and lower than SWE harness · [ ] general_swe still gets full ladder when classified |
| **Effort** | M |
| **Depends** | U0.2 |

**U1 exit gate:**

- [ ] Interactive coding profile matches guide  
- [ ] Fail shows tools + card without tribal knowledge  
- [ ] Optional: median TTF-write on n≥5 single-file samples ≤ 8  

---

### Wave U2 — Plan, permissions, headless DX

**Goal:** Operator mental model matches Grok/Claude Code.

#### U2.1 Plan approve surface (Grok-like)

| Field | Value |
|-------|-------|
| **Problem** | hard-plan exists; approval UX is thin vs Grok plan preview |
| **Design** | After plan: scrollable plan view, actions: approve / request changes / quit plan mode. Wire to existing plan handoff + `/execute-plan` |
| **Files** | plan UI under `babel-cli/src/ui/`, `planExecuteMode.ts`, `planHandoff.ts` |
| **Acceptance** | [ ] Operator can approve plan with `a` (or documented keys) without retyping · [ ] Request-changes re-enters plan |
| **Effort** | L |
| **Depends** | U1 preferred |

#### U2.2 Permission modes productized

| Field | Value |
|-------|-------|
| **Problem** | W1.4 thin modes; Grok has default / acceptEdits / dontAsk / bypass with deny still holding |
| **Design** | Map: `default` · `accept-edits` · `dont-ask` (automation) · `yolo`/`always-approve` (deny rules still apply). Document parity table vs Grok in guide |
| **Files** | `chatApproval.ts`, mode commands, sandbox interaction tests |
| **Acceptance** | [ ] Mode table in docs matches runtime · [ ] deny rules never bypassed by yolo · [ ] unit tests per mode |
| **Effort** | M |
| **Depends** | U1.2 |

#### U2.3 Headless flag parity (scripting)

| Field | Value |
|-------|-------|
| **Problem** | Grok `-p`, `--tools`, `--max-turns`, `--output-format streaming-json` are operator-familiar |
| **Design** | Align `babel` one-shot / chat-headless CLI flags and docs; do not break JSON contracts |
| **Files** | `babel-cli/src/cli/argv.ts`, workflow commands, docs/guides |
| **Acceptance** | [ ] Documented one-liner headless run with tool allowlist + max turns · [ ] smoke script |
| **Effort** | M |
| **Depends** | U0 |

---

### Wave U3 — Subagents & skills discovery

#### U3.1 Worktree implement merge path

| Field | Value |
|-------|-------|
| **Problem** | Worktree implement exists; merge-back deferred |
| **Design** | Optional merge with conflict report; default leave worktree for review (Grok worktree isolation pattern) |
| **Files** | `implementWorktreeAgent.ts`, sub_agent routing |
| **Acceptance** | [ ] Disjoint write_scope fan-out green · [ ] merge opt-in documented · [ ] claims matrix still excludes unsafe “mutating live subagents” until validated |
| **Effort** | L |
| **Depends** | U0 |

#### U3.2 Explore / plan / implement agent types (named)

| Field | Value |
|-------|-------|
| **Problem** | Grok `explore` / `plan` / `general-purpose` are operator-legible |
| **Design** | Map Babel sub_agent + lanes to named types; UI labels match |
| **Files** | sub_agent defs, exploreFeeder, plan lanes |
| **Acceptance** | [ ] Docs + UI show three named types · [ ] explore remains non-mutating by default |
| **Effort** | M |

#### U3.3 Multi-host skill discovery

| Field | Value |
|-------|-------|
| **Problem** | Grok loads `.grok` / `.claude` / `.agents` / `.cursor` skills automatically |
| **Design** | Babel interactive discovers project + user skills from those roots (configurable); catalog remains SoT for control-plane skills |
| **Files** | skill loader services, interactive bootstrap |
| **Acceptance** | [ ] Drop SKILL.md under `.agents/skills/` → invocable without catalog edit for **local** skills · [ ] catalog still required for control-plane export |
| **Effort** | M–L |

---

### Wave U4 — Sandbox productization & optional depth

#### U4.1 Sandbox profiles UX

| Field | Value |
|-------|-------|
| **Problem** | Grok `workspace` / `read-only` / `strict` are one flag |
| **Design** | Productize Babel sandbox as `--sandbox workspace|read-only|strict|off` with docs; Windows limits honest |
| **Files** | `sandbox.ts`, CLI flags, SECURITY.md pointer |
| **Acceptance** | [ ] Flag works on supported OS · [ ] doctor reports sandbox capability |
| **Effort** | M |

#### U4.2 Web tools reliability (only if needed)

| Field | Value |
|-------|-------|
| **Problem** | Grok web_search/fetch first-class; Babel may be stubby in some paths |
| **Design** | Ensure schema tools are runtime-wired or removed from schema (stubs = missing) |
| **Files** | `chatWebTools`, toolExecutor |
| **Acceptance** | [ ] No stub tools advertised · [ ] or live smoke web_fetch |
| **Effort** | S–M |

---

### Wave U5 — Strategic distribution (later)

Do **not** start until U0–U2 substantially complete.

| ID | Item | Notes | Effort |
|----|------|-------|--------|
| **U5.1** | ACP / IDE bridge | Grok ACP stdio; enables Zed/Neovim/custom clients | XL |
| **U5.2** | Local model backend | Ollama/LM Studio — preservation Tier 0 | L–XL |
| **U5.3** | Closed-loop debug product | run → fail → diagnose → fix → verify as first-class mode | L |

---

### Explicit non-goals

| Non-goal | Why |
|----------|-----|
| Re-implement L0–C / W0–W3 | Already shipped |
| Image/video/X tools in core | Grok-adjacent; plugins only |
| Make deep mode the daily default | Wrong product bet |
| Full SWE-A burn before U0 | Waste money without validation |
| Copy Grok closed binary internals | Patterns only |
| Claim market parity without dual-run | Claims matrix |

---

## 7. Definition of done & metrics

### Product DoD (peer-CLI upgrade)

Babel matches **Grok-class coding UX for the operator** when:

| # | Criterion | Wave |
|---|-----------|------|
| 1 | Single-file bugs: localize → str_replace → verify by default | U0–U1 |
| 2 | Failures leave complete artifact bundle | U0–U1 |
| 3 | Zero-write thrash cannot exhaust caps unnoticed (where hard-stop on) | U0 |
| 4 | Vague NL → intent plan + first-move guidance interactive | U1 |
| 5 | Plan approve / permission modes operator-legible | U2 |
| 6 | Worktree implement safe + documented | U3 |
| 7 | No false market-parity claims | always |

### Numeric targets

| Metric | Target |
|--------|--------|
| `tools_before_first_write` median (single-file) | ≤ 8 |
| Grok dual-run reference (same cell, strong model) | ≤ 5 (aspirational) |
| Zero-write past hard-stop (classes with HS > 0) | 0 |
| Fail payloads with empty `toolCalls` when tools ran | 0 |
| Operator diagnose fail time | < 5 min |
| Live smoke cost | ≤ $0.75, ≤ 40 turns |
| Grok-shadow offline scorecard | PASS |
| False-positive rate (scorecard FP cells) | 0 |

### Claim language (safe)

| Allowed after U0–U1 | Not allowed until dual measured |
|---------------------|----------------------------------|
| “Grok-shadow offline scorecard green” | “Babel matches Grok on SWE” |
| “Peer-CLI coding profile defaults shipped” | “Market parity with Grok Build” |
| “Live honesty smoke: patch or early BLOCKED” | “Beats Grok on coding tasks” |

---

## 8. File map

### Babel (primary)

| Path | Role |
|------|------|
| `babel-cli/src/agent/chatEngine.ts` | Main loop |
| `babel-cli/src/agent/chatToolDefinitions.ts` | Tool schema |
| `babel-cli/src/config/chatTaskClass.ts` | Task-class tunes |
| `babel-cli/src/agent/phaseToolPolicy.ts` | Phase-gate |
| `babel-cli/src/agent/chatZeroWritePolicy.ts` | Zero-write hard-stop |
| `babel-cli/src/agent/implementorScorecard.ts` | Grok-shadow scorecard |
| `babel-cli/src/agent/failureCard.ts` / `firstMoveCard.ts` / `intentCompiler.ts` | NL UX |
| `babel-cli/src/agent/planExecuteMode.ts` / `planHandoff.ts` | Plan→execute |
| `babel-cli/src/agent/implementWorktreeAgent.ts` | Worktree implement |
| `babel-cli/src/agent/chatApproval.ts` | Permissions |
| `babel-cli/src/interactive/execution/chatCore.ts` | Shared chat path |
| `babel-cli/src/services/playbooks/*` | Playbooks |
| `babel-cli/src/ui/*` | TUI surfaces |

### Grok (reference only — no copy of binary)

| Path / surface | Role |
|----------------|------|
| `~/.config/agent/docs/user-guide/15-agent-mode.md` | ACP |
| `…/16-subagents.md` | Subagents / personas |
| `…/19-plan-mode.md` | Plan approve UX |
| `…/22-permissions-and-safety.md` | Permission pipeline |
| `…/14-headless-mode.md` | Scripting flags |
| `…/18-sandbox.md` | Sandbox profiles |
| `…/08-skills.md` | Skill discovery |

---

## 9. Tracking table

Edit status as PRs land. Status: `pending` · `in_progress` · `done` · `blocked` · `wontfix`.

| ID | Title | Wave | Effort | Status | PR / commit | Notes |
|----|-------|------|--------|--------|-------------|-------|
| U0.1 | Offline observability + scorecard gate | U0 | S–M | **done** | `npm run test:u0-baseline` (offline: 34 tests, 9 suites, 0 fail) | One-liner: `cd babel-cli && npm run test:u0-baseline` — also `npm run evidence:scorecard` after build for human scorecard |
| U0.2 | Playbook mutate-before-pytest | U0 | S | **done** | | Re-verified — Tier D2 locks still green per 2026-07-16 re-check |
| U0.3 | Evidence guide freeze | U0 | S | **done** | | Guide coding profile table matches `chatTaskClass.ts` source; U0 baseline one-liner present; last_verified 2026-07-16 |
| U0.4 | Live dual-run honesty smoke | U0 | M | **done** | `docs/status/BABEL_GROK_DUAL_RUN_2026-07-16.md` | EARLY_BLOCK_RICH — 11 tool calls, blocked_report, FAILURE_CARD, $0.042 cost |
| U1.1 | TUI tool timeline + cards | U1 | M | **done** | `the Grok comparison feature branch` | `formatSessionToolTimeline()` + `buildInteractiveCard()` in `failureCard.ts`; wired into `chat.ts` fail/blocked/success branches; 7+7 new tests, 19/19 pass, tsc green |
| U1.2 | Coding profile defaults | U1 | M | **done** | `the Grok comparison feature branch` | `describeInteractiveCodingProfile()` + 5 tests; muted `coding profile: default (soft fuses, ...)` log in chat.ts; guide §2.4 interactive product defaults; `npx tsc --noEmit` green, 29/29 tests pass |
| U1.3 | Model tier in status bar | U1 | S–M | **done** | `the Grok comparison feature branch` | `formatRoutingStatusLabel()` in `turnRoutingReceipt.ts`; `routingLabel` field on `StatusBarState`; wired via `chat.ts` → ctx → `replSessionUi`; piped `turnRouting` through streaming path; 6 new tests, all pass, tsc green |
| U1.4 | Slim interactive prompt stack | U1 | M | **done** | `the Grok comparison feature branch` | Interactive budget ≤12k (non-SWE) vs 24k (general_swe); playbook only for general_swe; 49 new+existing tests pass; tsc green |
| U2.1 | Plan approve UI | U2 | L | pending | | |
| U2.2 | Permission modes productized | U2 | M | pending | | Extend W1.4 |
| U2.3 | Headless flag parity | U2 | M | pending | | |
| U3.1 | Worktree merge path | U3 | L | pending | | |
| U3.2 | Named agent types | U3 | M | pending | | |
| U3.3 | Multi-host skill discovery | U3 | M–L | pending | | |
| U4.1 | Sandbox profiles UX | U4 | M | pending | | |
| U4.2 | Web tools non-stub | U4 | S–M | pending | | |
| U5.1 | ACP bridge | U5 | XL | pending | | Strategic |
| U5.2 | Local models | U5 | XL | pending | | Preservation |
| U5.3 | Closed-loop debug mode | U5 | L | pending | | |

### Shipped preconditions (do not re-open as U-items)

| ID | Status |
|----|--------|
| L0–C thrash + observability + NL modules | **done** |
| W0–W3 implementor core + Grok-shadow scorecard offline | **done** |
| TUI A–E + G1–G7 | **done** |

---

## 10. Factory / PR packaging

### Suggested PR stack (Graphite or sequential)

```text
PR1  U0.1 + U0.2 + U0.3     offline only
PR2  U0.4                     live smoke evidence (optional separate)
PR3  U1.2 + U1.4              coding profile + slim stack
PR4  U1.1 + U1.3              TUI visibility
PR5  U2.2 + U2.3              permissions + headless
PR6  U2.1                     plan approve UI
PR7  U3.*                     subagents + skills
```

### Factory campaign shape (if using factory skill)

| Campaign | Slices | Mode |
|----------|--------|------|
| `upgrade-u0` | U0.1 → U0.2 → U0.3 → (U0.4 manual live) | sequential, stop_on_hard |
| `upgrade-u1` | U1.2 → U1.4 → U1.1 → U1.3 | sequential after U0 exit |
| `upgrade-u2` | U2.3 → U2.2 → U2.1 | sequential |

**Do not** auto-start U3–U5 after U2 without explicit operator start.

### Verification commands (per change set)

```powershell
cd ./babel-cli
npx tsc --noEmit
# targeted tests for touched modules, e.g.:
npx tsx --test src/agent/implementorScorecard.test.ts
# after U0.1 wired:
# npm test -- <observability suite>
pwsh ../tools/check-architectural-budget.ps1   # if large files touched
```

### Live smoke template (U0.4)

```text
Task: single-file localized bug (fixture or A08-class)
Caps: $0.75, 40 turns
Collect: tools_before_first_write, write_rate, patch_reality, toolCalls[],
         policy_events, FAILURE_CARD or SUCCESS_CARD, cost_ledger
Write: docs/status/BABEL_GROK_DUAL_RUN_YYYY-MM-DD.md
```

---

## 11. Synthesis checklist (for implementors)

When implementing any U-item, ask:

1. **Does this increase model agency on ordinary coding?** If it adds a hard tool block on execute classes, justify against U0 dual-run.  
2. **Does this preserve Babel evidence?** Failures must still be diagnosable offline.  
3. **Is deep mode still opt-in?** Daily path stays chat coding profile.  
4. **Is the change Grok-pattern or Grok-clone?** Patterns only; keep Prompt OS + claims honesty.  
5. **Is it scored?** Prefer offline scorecard / unit gate before live spend.

---

## 12. Appendix — Root cause rollup (post L0–C)

| ID | Severity residual | Status | Wave |
|----|-------------------|--------|------|
| RC1–RC5 thrash control | — | Closed | — |
| RC6 Intent expansion | Low | Modules shipped; defaults | U1 |
| RC7 Env asymmetry | Medium | Honesty helpers shipped | U0.4 / F later |
| RC8 Routing visibility | Low | Receipts shipped | U1.3 |
| RC9 Playbook conflict | Medium | Partial | **U0.2** |
| RC10 Surface fragmentation | Medium | Partial | **U1.2 + U2** |
| RC11 Phase-gate on SWE | Medium–High if re-enabled | Keep off for execute | policy lock |
| RC12 Model tier | Medium | Product/provider | U1 + ops |
| RC13 Subagent mutation | Medium | Worktree core done | **U3** |
| RC14 IDE distribution | Medium | None | **U5** |

---

## 13. Change log

| Date | Change |
|------|--------|
| 2026-07-16 | Initial CANONICAL upgrade audit (comparison + U0–U5 plan + tracking) |

---

*Audit date: 2026-07-16. Implementation truth remains code + tests. Update §9 as PRs land; re-verify confidence after U0.4 live dual-run.*
