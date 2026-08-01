# Babel Reliable Executor Roadmap (2026-08-01)

<!--
status: ACTIVE
last_verified: 2026-08-01
-->

**Status:** ACTIVE — canonical ChatEngine executor reliability plan  
**Scope:** Make Babel a **consistent, recoverable, proof-carrying coding executor** on the daily ChatEngine path  
**Baselines:** Babel `main` @ `63c3942` (Pri-1 #41 + C2/Pri-3 #42); 4a5d reval autopsy; Aug-1 peer research corpus  
**Strategy:** Peer-class **execution substrate** under Babel **trust contracts** — not a clone of OpenCode/Codex/Grok, not policy-only stacking  

**Supersedes for harness loop work (when landed as repo plan):**  
- `docs/plans/BABEL_CODEX_HARNESS_PARITY_IMPLEMENTATION_PLAN_2026-07-14.md` (keep historical; absorb unfinished P0s)  
- Pairwise Aug-1 research → this roadmap is the **action layer**  
**Does not replace:** control-plane / Prompt OS catalog work; deep pipeline remains opt-in governance  

---

## 1. Problem statement

Babel already has stronger **terminal honesty vocabulary** than peers (gates, ENV_BLOCKED, preflight, critic, policy-events). Peers have stronger **continuation substrate** (durable tool lifecycle, snapshots/rewind, client/server, progressive recovery).

Live Pro evidence (4a5d, campaign `2026-08-01T06-17-30-live`) shows the product fails as a reliable executor even when:

- dep preflight succeeds (`dep_ready=true`),
- Pri-1 post-write repair fires,
- the model produces an interface-aligned production patch.

Failure mode: **post-write verify collapses** → model invents non-authoritative “green” (`pip install requests`, ad-hoc `_test_*.py`) → honesty path can accept install as completion evidence → progress thrash → `BLOCKED_EXTERNAL` with `gold_diff=false` and live_pass 0.

**Root causes (ordered by leverage):**

| ID | Hole | Evidence |
|----|------|----------|
| H1 | Authoritative verify is **deny-list soft**, not allowlist | `isLikelyVerifierCommand` defaults **true**; `pip install` greens receipt |
| H2 | Agent ad-hoc tests / install cmds can become last “verifier” | 4a5d `completion_verification` = `pip install requests` pass |
| H3 | SWE-Pro **does not apply `test_patch`** before verify | `test_get_statement_values` absent on disk; pytest exit 4 |
| H4 | Prompt path injection stringifies list fields with brackets | Task text: `pytest ['openlibrary/...` |
| H5 | Scoreboard **gold_diff-only** vs interface/fail_to_pass | Agent close to fail_to_pass requirements; gold is multi-file PR |
| H6 | Tool/session durability incomplete | Mid-tool crash/resume weak; dual conversation authority risk (July plan) |
| H7 | Static thrash counters kill recoverable sessions | Progress thrash after fake green; research consensus |
| H8 | Edit/apply_patch recovery weaker than peers | Exact str_replace + git-apply primary path |
| H9 | In-process TUI/engine coupling | Client kill = agent kill; ADR-010 still D1 sketch |
| H10 | ChatEngine monolith | Gate, tools, policy, provider, persistence co-located |

---

## 2. North-star architecture

```
User / clients (TUI · headless · later app-server)
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│  Session Runtime (orchestrator, not shared memory bag)    │
│  - turn loop · budgets · mode (chat|plan|deep-profile)    │
└───────────────┬───────────────────────────────────────────┘
                │
     ┌──────────┼──────────┬──────────────┬─────────────────┐
     ▼          ▼          ▼              ▼                 ▼
 Provider   Tool      Workspace      Progress         Acceptance
 Gateway    Runtime   Transactions   Controller       + Evidence
 (normalize (lifecycle  (revision,     (progress-      (allowlist
  retry,     pending→   snapshot,      based nudge/    verify,
  finish)    result,    undo)          restrict)       receipts,
             idempotent)                               ENV_BLOCKED)
     │          │          │              │                 │
     └──────────┴──────────┴──────────────┴─────────────────┘
                              │
                              ▼
                 Durable SessionEvent log + WorkspaceRevision
                 (append-only, replayable, dual-read with transcript)
```

**Non-negotiables (preserve):**

- Completion honesty for execute-class (never treat model stop as verified complete)
- ENV_BLOCKED / dep preflight (C2)
- Pri-3 structured env vs policy signatures
- Multi-provider BYOM
- Windows-first Node runtime
- Deep/plan as opt-in rigor, not second daily engine

**Reject:**

- Dropping the gate for “speed”
- Full Rust/Bun/OpenTUI rewrite
- More static kill thresholds before progress model
- Wave B n-grind without honesty + substrate fixes
- Enforcing coding kill-switches until n≥20 **and** `later_succeeded` samples

---

## 3. Success metrics (definition of “reliable executor”)

### 3.1 Product SLIs (must move)

| Metric | Today (approx) | Wave-A target | Wave-C target |
|--------|----------------|---------------|---------------|
| **False-complete rate** (install/ad-hoc accepted as green) | >0 (4a5d hole) | **0** on fixture suite | 0 + receipt integrity |
| **Authoritative verify attempt rate** after first write | Partial | ≥90% sessions with production write | ≥95% |
| **Verified pass rate** (fixture + mini Pro) | 0/3 reval | ≥1/3 OL reval or clear FAILED_WITH_EVIDENCE not fake green | ≥30% mini suite |
| **Empty-patch rate** (mutate-capable tasks) | High on C2 cells historically | ↓ after readiness; measure | ↓ |
| **Premature BLOCKED** on recoverable investigate | Present | −30% vs baseline | −50% |
| **Kill mid-tool resume correctness** | Weak | Golden tests green | Fault-injection suite |
| **Duplicate mutation on resume** | Risk | 0 on golden | 0 |

### 3.2 Evaluation rule (invariant)

**Only** counts as task success:

- non-empty honest production patch when required, **and**
- green **authoritative** verifier (project/dataset tests), **or**
- explicit terminal: `ENV_BLOCKED` / `POLICY_BLOCKED` / `BUDGET_EXHAUSTED` / `FAILED_WITH_EVIDENCE` with correct class

**Never** count as success: rich BLOCKED, shadow PE harvest alone, install exit 0, ad-hoc script green.

### 3.3 Same-model Track B (meta)

After Wave B: mini suite of 8–12 tasks Babel vs self-ablation (gate-on/off, settle on/off). Peer dual-run optional later.

---

## 4. Roadmap overview (waves)

| Wave | Name | Theme | Duration (indicative) | Exit gate |
|------|------|-------|----------------------|-----------|
| **W0** | Freeze & instrumentation | Decisions, metrics, fixtures | 2–4 days | Fixtures + ADR freeze |
| **W1** | Honesty kernel | Close verify holes H1–H5 | 1–2 weeks | False-complete suite 0; 4a5d reval improved class |
| **W2** | Durable execution kernel | Tool lifecycle + event log H6 | 2–3 weeks | Kill/resume golden |
| **W3** | Progress & recovery UX | Adaptive stop H7; checkpoints | 1–2 weeks | −30% premature BLOCKED |
| **W4** | Edit & workspace transactions | H8 mutation reliability | 2–3 weeks | Partial-apply receipts; undo batch |
| **W5** | Runtime surfaces | Protocol D2 thin client H9 | 2–4 weeks | Client kill ≠ agent kill (flag) |
| **W6** | Surpass layer | Acceptance contracts, evidence graph | ongoing | Claim-linked VERIFIED_COMPLETE |
| **W7** | Debt collapse | Monolith extraction H10; deep profile | ongoing | ChatEngine thin orchestrator |

**Critical path for Pro / executor reliability:** **W0 → W1 → W2 → W3**, then reval.  
W4–W7 improve general coding quality and peer parity but must not block honesty fixes.

```
W0 ──► W1 (honesty) ──► reval 4a5d
              │
              └──► W2 (durable settle) ──► W3 (progress) ──► mini Track B
                                              │
                                              ├──► W4 (edit/tx)
                                              └──► W5 (app-server) ──► W6/W7
```

---

## 5. Wave 0 — Freeze & instrumentation

### Goals
- Single written strategy + metric harness so later PRs are comparable.
- Capture request dumps for same-model debugging (research Issue #10).

### Work items

| ID | Work | Files / area | Acceptance |
|----|------|--------------|------------|
| W0.1 | Land this plan under `docs/plans/` + update `docs/plans/README.md` canonical pointer | `docs/plans/BABEL_RELIABLE_EXECUTOR_ROADMAP_2026-08-01.md` | Linked from status research docs |
| W0.2 | ADR freeze: ChatEngine sole daily path; keep gate; Node runtime; layered substrate | `docs/adr/` (5 short ADRs or one ADR pack) | Merged |
| W0.3 | False-complete fixture suite (unit) | `completionGatePolicy.test.ts` + new fixtures | `pip install`, `echo ok`, `python _test_x.py`, `python -c` all non-authoritative |
| W0.4 | Optional request recorder flag | runners + test | Dump system/tools/messages JSON for one chat turn |
| W0.5 | Reval dataset hygiene | keep local `phase2-*.jsonl` untracked | Document reval command in plan |

### Decisions locked in W0

1. Direction C/D: peer substrate + Babel trust.  
2. Deny-by-default authoritative verify (allowlist), not generous default-true.  
3. SWE-Pro applies `test_patch` before agent **or** before first verify (prefer before agent for collectability).  
4. Live pass: dual report **gold_diff** and **fail_to_pass execution** (don’t hide either).  
5. No new hard thrash kills until progress controller lands.

---

## 6. Wave 1 — Honesty kernel (highest product leverage)

**Purpose:** Make “complete” mean something; stop fake green; make Pro verify runnable.

### W1.1 Authoritative verifier allowlist (H1, H2)

**Problem:** `isLikelyVerifierCommand` returns true for unknown commands → `pip install requests` can become last green receipt.

**Design:**

```
isAuthoritativeVerifierCommand(cmd):
  if empty → false
  if agent-owned ad-hoc (_verify|_test_|_check_*) → false
  if inline probe (python -c / node -e) → false
  if package-manager install/modify (pip/npm/yarn/pnpm/cargo add/…) → false
  if shell junk (del/echo/ls/…) → false
  if matches allowlist prefixes (pytest, npm test, cargo test, go test, make test, …)
     OR matches session.boundAuthoritativeCommands (from project discovery / dataset)
     → true
  else → false   // DENY unknown (change from default true)
```

**Capture rules:**

- Only **authoritative** green updates `lastVerifierReceipt` used for honesty.
- Non-authoritative greens still log as `verify_attempt` with `authority=false`.
- `completion_verification` payload must include `authority` + `command` + deny reason if fail.

**Files:**  
`babel-cli/src/agent/completionGatePolicy.ts`, tests; wire sites in `chatEngine.ts` (~3548), `chatEngineCriticBudget.ts`, payload builders (`chatCore.ts` / commands).

**Acceptance:**

- Unit: 4a5d-class commands rejected.  
- Integration: finish with only `pip install` green → gate reject / not VERIFIED.  
- No regression on `npm test` / `pytest path::node` fixtures.

### W1.2 Bound dataset / project verify commands (H3, H4)

**A. Prompt builder hygiene**

- Parse `fail_to_pass` / `selected_test_files_to_run` whether stringified list or JSON array.
- Emit clean commands:  
  `python -m pytest openlibrary/tests/core/test_wikidata.py::test_get_statement_values -q`  
- Never inject `['path` brackets.

**B. Apply `test_patch` in SWE-Pro campaign**

In `swebenchProCampaign.ts` workspace prep:

1. Materialize repo at base commit.  
2. **Apply `test_patch`** (git apply / patch) into workspace **before** agent.  
3. Record receipt: `test_patch_applied=true|false` + error.  
4. Optionally bind authoritative command list from `fail_to_pass` into chat task env / engine options.

**C. Post-write verify preference**

After first production write, progress policy / repair window:

- Prefer bound fail_to_pass command for `test_run`.  
- Soft-nudge if agent runs install or ad-hoc script instead.

**Acceptance:**

- On 4a5d workspace after prep: `test_get_statement_values` exists.  
- Agent prompt contains clean pytest path.  
- Reval notes include `test_patch_applied`.

### W1.3 Campaign scoring honesty (H5)

**Dual metrics in campaign report:**

| Field | Meaning |
|-------|---------|
| `gold_diff_ok` | Semantic gold match (existing) |
| `fail_to_pass_ok` | Ran bound tests after agent; exit 0 (new, best-effort host) |
| `live_pass` policy | Document: currently gold-based; optional flag `BABEL_SWE_PRO_PASS_MODE=gold|ftp|both` |

**Do not** silently redefine pass without a flag. Default keep gold for continuity; **report both**.

**Acceptance:** campaign-summary shows both columns; 4a5d autopsy reproducible.

### W1.4 Terminal outcome cleanup

When last verify was non-authoritative or pytest collect-failed:

- Prefer `FAILED_WITH_EVIDENCE` / clear `verifier_red` / `verifier_non_authoritative` over progress-terminal thrash when a production patch exists.  
- Map collect ImportError after writes carefully (Pri-3 lineage: don’t re-ENV_BLOCK wrongly after mutate).

**Acceptance:** 4a5d-class run does not claim completion_verification pass on install.

### W1 deliverables (PR sequence)

| PR | Title | Depends |
|----|-------|---------|
| PR-A | `fix(agent): authoritative verify allowlist + install deny` | W0.3 |
| PR-B | `fix(agent): SWE prompt path parse + test_patch apply` | — |
| PR-C | `feat(benchmark): dual gold/ftp scoreboard fields` | PR-B |
| PR-D | Reval note + optional 3-cell live reval (ops) | PR-A–C |

**Wave 1 exit:** false-complete unit suite green; local or live 4a5d no longer greens `pip install`; pytest can collect fail_to_pass after test_patch (env `web` may still soft-fail full suite — document).

---

## 7. Wave 2 — Durable execution kernel

**Purpose:** Survive crash, resume without double-mutate, single authority for tool results.

### W2.1 SessionEvent log (append-only)

Minimal event kinds (v1):

- `user_submitted`, `model_started`, `assistant_delta` (optional thin)
- `tool_proposed` → `tool_started` → `tool_completed` | `tool_failed` | `tool_cancelled`
- `mutation_batch` (files + pre/post hashes)
- `verifier_attempt` (authority flag)
- `gate_decision`, `policy_intervened`
- `compaction_created`, `turn_ended`

**Storage:** dual-write next to existing transcript / thread event log under `runs/chat-sessions/{id}/` (JSONL first; SQLite optional later).  
**Do not** block on full OpenCode SQLite port.

**Files:** `threadEventLog.ts`, new `sessionEvents.ts`, `chatEngine.ts` write-through, resume path `chatSessionResume.ts`.

### W2.2 Tool settlement before side effects

Protocol:

1. Persist `tool_proposed` with idempotency key (call_id).  
2. Execute.  
3. Persist terminal tool event with exit/output digest.  
4. Resume: skip re-exec of completed keys; mark interrupted if started without complete.

**Acceptance:** kill process mid-`run_command` → resume shows interrupted tool; no silent success; no double write for completed mutation keys.

### W2.3 Single conversation authority

- One durable message graph → compile provider messages.  
- Deprecate dual “Markdown flatten all history as user blob” for native-tool providers where possible (absorb July plan RC-1).  
- Text-tool fallback remains adapter for weak models only.

**Acceptance:** tool_call_id pairing preserved across ≥3 tool turns in fixture; DeepSeek path regression tests.

### W2.4 Provider normalize + retry

- Shared `normalizeFinishReason`, Retry-After / 5xx classifier across runners.  
- No silent provider switch without continuity event.

**Acceptance:** cross-runner unit fixtures; no behavior change on happy path.

### W2 PR sequence

| PR | Title |
|----|-------|
| PR-E | SessionEventV1 schema + dual-write |
| PR-F | Tool settle + kill/resume golden |
| PR-G | Provider conversation continuity (native tools) |
| PR-H | Provider retry normalize |

**Wave 2 exit:** kill/resume golden green; tool ID resume fidelity 100% on fixture corpus.

---

## 8. Wave 3 — Progress controller & recovery policy

**Purpose:** Stop thrashing without killing recoverable work; keep honesty.

### Design: progress score (per turn)

Progress events (any counts as progress):

- new production file touched / successful mutation
- new unique error signature from tests
- failing test count decreases
- authoritative verifier advanced (ran / exit improved)
- env blocker resolved (preflight ready)

**Interventions (ordered):**

1. none  
2. nudge  
3. restrict tools (act_or_verify post-write — already partial via Pri-1)  
4. last-chance repair window  
5. terminal BLOCKED / FAILED_WITH_EVIDENCE  

**Replace / soften:**

- text-only hard BLOCKED at fixed N  
- gate strikes max 3 → hard BLOCKED (prefer last-chance + clear reason)  
- pure turns_without_write kill when localization still advancing  

**Preserve:**

- completion honesty gate  
- budget kill (cost/wall)  
- doom-loop (identical tool ×3 → ask/stop)  
- ENV_BLOCKED  

**Files:** `chatZeroWritePolicy.ts`, `stallDetector.ts`, `repetitionDetector.ts`, `chatEngineCriticBudget.ts`, progress module new.

**Acceptance:** ablation on investigate-heavy fixtures: fewer premature BLOCKED; false-complete suite still 0.

---

## 9. Wave 4 — Workspace transactions & edit reliability

| Item | Work | Acceptance |
|------|------|------------|
| W4.1 | Mutation batch: pre-image hashes, batch id, structured diff | Undo restores digests |
| W4.2 | Actual patch reality from FS (not only tool log) | `patch_bytes` matches git/fs |
| W4.3 | Fuzzy apply_patch clean-room (optional whitespace/line-end) | Near-miss fixtures |
| W4.4 | str_replace error: nearest context snippet | Model can recover next turn |
| W4.5 | Per-file write mutex for parallel tools | No torn multi-write |

**Note:** Keep exact `str_replace` as primary; fuzzy is assist, never silent wrong match.

---

## 10. Wave 5 — Runtime surfaces (multi-client readiness)

Implement **ADR-010 D2 minimal**:

| Method / event | Purpose |
|----------------|---------|
| `thread.create/resume` | session |
| `turn.submit/cancel` | ChatEngine |
| `turn.event` stream | ChatEvent mirror |
| `permission.request/respond` | approvals |
| `gate.rejected`, `env_blocked` | trust UX |

**Flag:** `BABEL_TUI_CLIENT=1` optional thin client; default stays in-process until stable.

**Defer:** web/desktop, full ACP, plugin marketplace.

**Acceptance:** external client runs one full turn; kill TUI process with server mode → agent continues (server flag on).

---

## 11. Wave 6 — Surpass (proof-carrying completion)

| Component | Description |
|-----------|-------------|
| Acceptance-contract compiler | Task → claims, required evidence, non-goals |
| Evidence graph | claim → patch/test/critic/env nodes |
| Revision-bound receipts | workspace rev + digests + cmd + exit + output digest |
| Independent verifier process | read-only tree / clean worktree; cannot mutate tests under eval |
| Readiness planner v2 | generalize preflight beyond Python editable |
| Adaptive verify planner | retest only impacted tests after edit |

**Exit:** `VERIFIED_COMPLETE` requires claim coverage, not only command exit 0.

---

## 12. Wave 7 — Structural debt

- Extract ChatEngine into services listed in architecture diagram.  
- Deep pipeline as **profile** of same kernel (shared tool settle + gate), not forked truth.  
- Remove lite fossils / version conflict (`package` 0.1.0 vs CLI 1.0.0).  
- Unify tool names model↔executor (`read_file` vs aliases).

---

## 13. Concrete first 15 implementation issues (build order)

1. **Authoritative verify allowlist + install deny** (H1/H2) — tests from 4a5d  
2. **lastVerifierReceipt only authoritative** + payload `authority` field  
3. **Parse fail_to_pass / selected_test_files** without list brackets (H4)  
4. **Apply test_patch in swebenchProCampaign workspace prep** (H3)  
5. **Bind authoritative commands into ChatEngine options** for campaign tasks  
6. **Dual scoreboard gold_diff + fail_to_pass_ok** (H5)  
7. **Terminal mapping: non-auth green ≠ complete**  
8. **SessionEventV1 + dual-write**  
9. **Tool pending→complete settle + kill/resume golden**  
10. **Native tool conversation continuity** (July RC-1 residual)  
11. **Progress score v1 + soft text-only/gate-strike**  
12. **Mutation batch hashes + undo last batch**  
13. **str_replace near-miss diagnostics**  
14. **Request recorder for Track B**  
15. **ADR pack + docs/plans README canonical switch**

Issues 1–7 = **Wave 1 critical path**. 8–10 = Wave 2. 11 = Wave 3. 12–13 = Wave 4 start.

---

## 14. Validation plan

### Continuous (every PR)
- `cd babel-cli && npx tsc --noEmit && npm test` (or targeted tests for slice)  
- Gate unit tests for any honesty change  
- `pwsh tools/preflight-ratchet.ps1` if large files touched  

### Wave 1 reval (ops, cost-aware)
```text
npm --prefix babel-cli run build
npm --prefix babel-cli run benchmark:agent:swe-pro -- --provider live --limit 3 --early-stop 5 \
  --dataset <phase2-pri1-reval-ol.jsonl>
```
**Pass criteria:** no cell with `completion_verification` pass on non-auth command; ≥1 cell with real pytest attempt after test_patch; signatures remain honest.

### Wave 2 golden
- Fault-injection: kill mid-tool, mid-stream, after mutate before persist  

### Wave 3 ablation
- Same tasks with progress controller on/off; report premature BLOCKED rate  

### Track B mini suite (after W2)
1. Single-file unit fix  
2. False-complete temptation  
3. Ad-hoc `_test_` temptation  
4. `pip install` temptation  
5. Missing dep ENV  
6. Kill/resume mid-tool  
7. Multi-file edit  
8. Windows path task  

---

## 15. Risk register

| Risk | Mitigation |
|------|------------|
| Allowlist too strict → blocks legitimate custom verify | Session-bound commands from discovery + task text overrides |
| test_patch apply breaks workspace | Receipt + fail open with signature; don’t silent skip scoring |
| Event log perf / size | Cap tool output digests; prune bodies to artifacts |
| Dual write format migration | Dual-read transcript forever until events proven |
| Scope creep into full peer clone | Wave exits enforce; W5+ gated on W1–W3 metrics |
| API cost of revals | 3-cell OL set only until W1 exit |

---

## 16. Explicit non-goals (next 6–8 weeks)

- Full OpenCode SQLite monorepo import  
- Bun runtime  
- OpenTUI rewrite  
- OS sandbox parity (optional later)  
- Full 731-instance Pro Docker eval  
- Re-default coding kill-switch enforce  
- Plugin marketplace / share-server  
- Prompt OS catalog expansion for pass-rate  

---

## 17. Relationship to prior plans

| Plan | Relationship |
|------|----------------|
| Codex harness parity 2026-07-14 | Absorb residual protocol fidelity + async executor + progress arbiter into W2–W3; **honesty allowlist is new P0 ahead of many July items** |
| Grok upgrade audit U0–U5 | UX/agency waves remain; this plan is **executor reliability** spine |
| Four-way teardown W0–W7 | Aligns; this plan is more concrete post-#41/#42 + 4a5d |
| Aug-1 OpenCode/Codex/Grok research | Strategy source; this is implementation |
| SWE improvement plans | Campaign test_patch + dual scoreboard live here |

---

## 18. Suggested team operating rhythm

1. **Ship PR-A (allowlist) first** — smallest, highest ROI, pure unit-testable.  
2. **PR-B/C (test_patch + paths + scoreboard)** same week.  
3. **Cheap reval** (3 OL) before large substrate PRs.  
4. **Only then** multi-week event-log work (W2).  
5. After each wave: short handoff with metrics table + supersedes prior handoff.

---

## 19. Immediate next actions (when leaving plan mode)

1. Write plan to repo: `docs/plans/BABEL_RELIABLE_EXECUTOR_ROADMAP_2026-08-01.md`  
2. Update `docs/plans/README.md` canonical harness pointer  
3. Implement **Issue 1** (allowlist) + tests on a feature branch  
4. Issue 3–4 (prompt parse + test_patch)  
5. Reval 4a5d; write one-page results note under `docs/status/` or campaign dir  

**Do not** start app-server or fuzzy-patch ports before Issues 1–4 land.

---

## 20. One-paragraph executive summary

Babel becomes a reliable executor by **closing the completion-honesty hole first** (allowlist authoritative tests, reject install/ad-hoc greens, apply SWE `test_patch`, fix prompt paths, dual-score gold vs fail_to_pass), then **installing a durable tool/session kernel** so work survives crash and resume, then **replacing static thrash kills with progress-based control**, and only later matching peers on edit transactions and multi-client protocol—while **never** equating model stop with verified complete. Success is measured by false-complete rate → 0, real post-write verify, kill/resume correctness, and rising verified pass rate on a fixed mini suite—not by richer BLOCKED telemetry or more policy strikes.
