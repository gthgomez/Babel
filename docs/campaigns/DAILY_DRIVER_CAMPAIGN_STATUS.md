<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-09-05
-->

# Daily Driver Campaign — Status

Living status document. Updated at each phase boundary and before any PR is opened.

- Campaign: Reconciled Platform → Exceptional Daily Coding Agent
- Baseline: [DAILY_DRIVER_CAMPAIGN_BASELINE.md](./DAILY_DRIVER_CAMPAIGN_BASELINE.md)
- Plan: [DAILY_DRIVER_CAMPAIGN_PLAN.md](./DAILY_DRIVER_CAMPAIGN_PLAN.md)
- Baseline SHA: `015c7b374a3b2e67f7a5814508db0bd7f14ed263`
- Canonical branch: `main` (phase work lands per-phase PR; `agent/daily-driver` merged and retired)

## Phase Tracker

| Phase | Scope | State | PR | Notes |
| --- | --- | --- | --- | --- |
| 0 | Baseline audit | **COMPLETE** (2026-09-04) | — | GitHub state + 5 deep audits reconciled against `main` @ `015c7b3` |
| 1 | Model Intelligence operator surface | **COMPLETE** (2026-09-05) | PR-1 = [#141](https://github.com/gthgomez/Babel/pull/141), merged as `bc1b4452587c6cd45679ac3a3b1eaca2b7cbaea5` | `/model show\|why\|health`, truthful status bar/header, `/status` provider+fallback rows, `babel models list`; review findings A–E repaired + isolated-review blocking finding fixed; all six required checks green at merge (incl. `trusted-control-plane`, `blockers: []`, AUTONOMOUS tier) |
| 2 | Provider reliability UX | PENDING | PR-2 | After PR-1 |
| 3 | Daily Chat/TUI polish | PENDING | PR-3 | After PR-2 |
| 4 | Windows execution polish | PENDING | PR-4 | Independent lane; before Phase 6 |
| 5 | Signed review operations | PENDING | PR-5 | Independent lane; human key ceremony checklist included |
| 6 | End-to-end evaluations | PENDING | PR-6 | After PR-1, PR-2, PR-4 |
| 7 | Release readiness | PENDING | PR-7 | Last; publication is human-gated |

Stop/go: **CAMPAIGN_READY_TO_EXECUTE** (Plan §E).

## Verification Log

| Date | Check | Scope | Result |
| --- | --- | --- | --- |
| 2026-09-04 | `npm ci` | campaign worktree | pass (sharp install-script warning only — remote-UI optional dep) |
| 2026-09-04 | `tsc --noEmit` | full `babel-cli` at baseline | **pass (exit 0)** |
| 2026-09-04 | GitHub CI | `main` Public Release Gate + trusted-control-plane through #140 | green |
| 2026-09-04 | Required checks inventory | ruleset `protect-main` (active) | security, public-content-policy, linux-validation, public-pr-metadata, windows-portability (+ trusted-control-plane workflow) |
| 2026-09-04 | `tsc --noEmit` (main + scripts configs) | after PR-1 changes | pass |
| 2026-09-04 | `interactive/commands` suite (24 tests, now wired into `test:unit`) | incl. 14 new modelDetail tests + 1 repaired stale expectation | **24/24 pass** |
| 2026-09-04 | `src/commands` suite (30 tests) | coreCommands `models list` addition | **30/30 pass** |
| 2026-09-04 | renderers-snapshot + dailyDriverPolish + userCommandSmoke | 75 tests | **75/75 pass** |
| 2026-09-04 | `chat.dailyDriver` execution suite | replSessionUi status-bar change | **6/6 pass** |
| 2026-09-04 | integration-snapshot + statusBar | header snapshot deliberately updated (`Qwen 3 32B` → `auto`) | **pass** |
| 2026-09-04 | `architectureConformance` | new module layering | **23/23 pass** |
| 2026-09-04 | `npm run test:ui` (full CI-required UI suite) | 100 files discovered | **2590 pass / 0 fail** |
| 2026-09-04 | `babel models list` real-output smoke | CLI-level operator surface | pass — backend/provider/route/context/cost/metadata/fallback/stages all rendered |
| 2026-09-05 | GitHub Actions log audit | trusted-control-plane run 33933253370 (PR head `d6aa2b4`) | **fail diagnosed** — `pr_gate_exception`: strict-mode `schema_version` access crashes on the evidence-transport stub written when the PR has no review-evidence comment; plus `pr_is_draft`. Root cause lives in base-rooted gate scripts on `main`, not in #141 (see Correctness repairs) |
| 2026-09-05 | `tsc --noEmit` (babel-cli + tsconfig.scripts) | after findings A–E repairs | **pass (exit 0)** |
| 2026-09-05 | `npm run build` | after findings A–E repairs | **pass (exit 0)** |
| 2026-09-05 | `interactive/commands` suite (34 tests) | 20 new tests: health evidence tiers, fallback-not-ready, stage correlation, explicit-zero vs missing cost, upstream terminology, secret non-leak, no-network render, cache invalidation, malformed artifacts, five-question acceptance | **34/34 pass** |
| 2026-09-05 | `src/commands` + `execute.schemaFailureLedger` + `architectureConformance` | execute.ts `upstream_provider` persistence | **55/55 pass** |
| 2026-09-05 | integration-snapshot + renderers-snapshot + statusBar + dailyDriverPolish | no snapshot drift from repairs | **pass** |
| 2026-09-05 | `npm run test:unit` (full) | 7133 tests | **7077 pass / 16 fail — all 16 verified pre-existing or environmental, none caused by the repairs**: 8 smallFix (need `OPENROUTER_API_KEY`; identical 11/8 split on untouched `d6aa2b4`), 1 portable-golden byte-compare (Windows CRLF checkout artifact; green on Linux CI), 7 parallel-interference flakies that pass serially with the repairs in place (documented P2 debt) |
| 2026-09-05 | `tools/check-public-content-policy.ps1` | repaired tree | pass |
| 2026-09-05 | `babel models list` real-output smoke | repaired renderer | pass — the available-models table renders `n/a` for `deepseek-v4-pro-openrouter` (previously fabricated `$0/M`); single-tier route renders `none — single-tier route` |
| 2026-09-05 | Isolated read-only review round 1 (`autonomous_review_evidence_v1` intake) | full diff `015c7b3...a552107` | **REQUEST_CHANGES — 1 blocking finding, accepted and fixed**: the resolver computes `approximateCostPerRunUsd` from `?? 0` inputs and sets it unconditionally, so `/model show` rendered a fabricated `~$0.0000/run` for models without cost metadata (production shape; the original test masked it with a shape real resolvers never produce). Fix: the per-run estimate renders only when at least one per-M cost is published; regression test uses the production shape; verified via the real resolver for `deepseek-v4-pro-openrouter`. Non-blocking notes adopted: policy path in the snapshot-cache key, `(historical)` markers on failure/last-run rows, `redactSecrets` on rendered error text, reachability wording tightened |
| 2026-09-05 | GitHub merge record | PR #141 | **MERGED** 2026-09-05T05:27:31Z as `bc1b4452587c6cd45679ac3a3b1eaca2b7cbaea5`; all six required checks green at head `e3872bd` (trusted-control-plane pass, `blockers: []`, AUTONOMOUS review tier, no exception); post-merge `main` Public Release Gate success |

### Trust-plane history correction (verified against GitHub, 2026-09-05)

The first post-#138 trust-plane re-certification was **PR #139** ("feat:
product/runtime consolidation on the canonical trust plane", head
`c5d533f04`, based directly on post-#138 main `31e7d7e0e`): its
`trusted-control-plane` run completed **success** at 2026-09-04T19:33:58Z (started 19:33:20Z).
Earlier campaign notes that described #141 as "the first PR on the new main
to pass the trust plane end-to-end" were wrong. Accurate distinctions:

- **#139** — first post-#138 ordinary PR proving the upgraded trust plane
  end-to-end (CERTIFIED-era default path, no evidence comment required under
  the pre-crash gate behavior).
- **#141** — later successful reconfirmation during the Daily Driver
  campaign, notable as the first end-to-end exercise of the **AUTONOMOUS
  review tier** (isolated read-only reviewer evidence + ready-for-review +
  close/reopen retrigger) after the evidence-transport crash was diagnosed.

Superlatives (`first`, `only`, `never before`) in canonical records must be
checked against GitHub history before inclusion — this correction is
recorded as a standing rule in `CLAUDE.md`.

### Snapshot-cache measurement (2026-09-05)

`resolveModelSnapshot`'s hot path (cache hit: key construction + one
`statSync` of the policy file) measured **~46 µs/call (~21,800 calls/s)** on
Windows; cold resolution ~2.3–3.6 ms. Status-bar renders happen at most once
per turn/keystroke, so the stamp-validation cost is negligible against
terminal I/O — measured, documented, left unchanged (correctness outranks
micro-optimization).

### Recovery preservation (2026-09-05)

Unlanded recovery-era work (26 modified + 14 untracked files on the retired
local checkout) was preserved durably before cleanup and audited against
current `main`: recovery ref `recovery/unlanded-20260905` @ `f0d38614`
(stash `0d48c6e9`, base `213e7469`), plus an independent git bundle and
source archive with SHA256 checksums outside the repository. Full
classification matrix: [RECOVERY_UNLANDED_20260905_AUDIT.md](../reconciliation/RECOVERY_UNLANDED_20260905_AUDIT.md).

### Repairs included in PR-1

- `config.modelInvalidate.test.ts` expected the superseded model id
  `deepseek/deepseek-v4-flash`; canonical `config/model-policy.json` pins the dated
  revision `deepseek/deepseek-v4-flash-0731`. Expectation aligned with the canonical
  policy (test was orphaned — `src/interactive/commands/` was not wired into any CI
  script; `test:unit` now includes the directory so CI runs it).

### Correctness repairs (post-review, 2026-09-05)

All five review findings were independently verified against the PR head and
repaired at the root cause. Epistemic rule now encoded in the surface:
**configuration is never presented as health, historical observations are
labeled, and unknown stays unknown.**

| Finding | Root cause | Repair |
| --- | --- | --- |
| A — `/model health` reported configuration, not health | Renderer showed credential-env presence, metadata freshness, and policy flags under a "health" heading with no observation or reachability tiers | `renderModelHealthForSnapshot` now renders distinct tiers: Policy / Credential (presence-only wording; missing = failure; unknown spec = unknown) / Metadata / Qualification (`not recorded` — Babel persists no per-route qualification evidence) / Observed (success or failure from the last run bundle, labeled historical, with stage + timestamp) / Receipts (recent provider-failure receipts for the active route from `session-events.jsonl`) / Reachability (`live reachability not checked` + the existing `--i-authorize-live` ping hint). No network access on render — regression-tested by patching `fetch` to throw |
| B — fallback rendered as `ready` from waterfall membership alone | `renderModelHealth` printed `${fallback.backendKey} ready` | Fallback now renders `configured` (+ `credential missing` when applicable, + `readiness not verified`); single-tier routes render `none configured — single-tier route` |
| C — `/model why` could pair one stage's waterfall outcome with another stage's routing rationale | `debug_dynamic_routing_*.json` files were sorted alphabetically and the last file used; filename order ≠ execution order | The routing decision is now correlated by the canonical key: the last `05_waterfall_telemetry.json` record's `stage` selects `debug_dynamic_routing_<stage>.json` (the file name embeds the stage label it was written for). A missing decision for that stage is stated explicitly; orphan debug files with no waterfall telemetry are never attributed. Last-run lines carry the stage and ISO timestamp |
| D — unknown cost rendered as `$0/M` | `renderAvailableModelsTable` used `estimated_cost_per_1m_output ?? 0` | Missing cost renders `n/a`; an explicit `0` still renders `$0/M` (it is a fact). `/model show` renders `cost unknown — not published in model policy` when a policy has no cost fields |
| E — provider model ID presented in a way that could read as the serving upstream | Run-bundle attempts dropped `RunnerInvocationMetadata.upstream_provider` | `WaterfallAttemptOutcome` now persists `upstream_provider` (nullable — gateways that do not expose it stay null). `/model why` renders `Last upstream: <x>` labeled `historical, not a guarantee of the next request`, or `not recorded — gateway did not expose a serving upstream` |

Additional repair (same class as B/C): `nextFallbackEntry` returned
`waterfall[0]` when the resolved backend key was not in the waterfall —
labeling a policy's primary tier as a "fallback". It now returns none; the
canonical builders always place the resolved backend in the waterfall, so no
legitimate route loses its fallback row.

Snapshot cache hardening (stale-state review): the auto-snapshot cache is now
keyed on the session model, the offline-lane flag, and the policy file's
mtime/size — policy edits, `BABEL_MODEL_POLICY_PATH` changes, and
offline/live flips re-resolve instead of serving frozen state. `/model
set|clear` still reset it explicitly. Regression tests cover the policy-file
and lane-flip invalidation paths.

Trusted control plane: the failing `trusted-control-plane` check was
diagnosed from the authoritative Actions log (run 33933253370). With no
review-evidence comment on the PR, the base-rooted evidence transport stages
a `transport_error` stub into `ai-review.json`; the gate's strict-mode
property access (`agent-pr-gate-common.psm1` `Test-AgentAutonomousReviewEvidence`,
`schema_version`) then crashes → `pr_gate_exception`. This is a pre-existing
robustness bug on `main`'s gate scripts (base-rooted, so it fires for *any*
HIGH-tier PR without evidence), **not** a PR-#141 regression, and the gate
scripts are protected trust-root paths — repairing them belongs to the
trust-plane lane, not this PR. The legitimate closure path for #141 was the
documented AUTONOMOUS review tier (`docs/architecture/TRUST_ROOT_UPGRADE.md`):
isolated read-only reviewer evidence bound to the exact base/head and diff
numstat digest, posted as a PR comment — plus marking the PR out of draft
(`pr_is_draft` was the second blocker). #141 obtained a green
`trusted-control-plane` with no exception at head `e3872bd`.

## Open Risks / Watch Items

- **Trust-plane gate robustness (main):** the `trusted-control-plane` gate
  crashes (`pr_gate_exception`) on any HIGH-tier PR that has no
  review-evidence comment, because the evidence transport writes a
  `transport_error` stub that the strict-mode evidence validator cannot
  read. The repair (deterministic fail-closed evidence handling + regression
  matrix + a comment-triggered re-evaluation so the lifecycle no longer
  needs close/reopen) is engineered in the trust-plane lane and **waits
  only on TrustRootUpgradeV1 signed authorization** (protected paths). Until
  it merges, every HIGH-tier PR must post review evidence *before* the gate
  runs, and re-trigger the workflow (close/reopen) after the comment lands.
- **Trust ceremony safety (added 2026-09-05):** ceremony coordinates now come
  exclusively from the machine-generated manifest (`tools/trust-ceremony.mjs`;
  digest semantics cross-verified against the gate's own
  Get-AgentProtectedDiffDigest), staleness validation fails closed with
  precise reasons, and PR-body ceremony sections are marker-delimited
  generated blocks (#144 body regenerated accordingly; pre-rebase coordinates
  marked SUPERSEDED - DO NOT SIGN). `babel review certify` now exits 0 only
  for CERTIFIED (2 = repair required, 3 = configuration/external blocker,
  4 = verification/lifecycle state), and authority construction is confined
  to the trusted-service-only services/reviewTrustedAuthority.ts module,
  enforced by reviewCustody.test.ts.
- ~~`.agents/rules/10-independent-review-policy.md` is referenced by
  `docs/architecture/TRUST_ROOT_UPGRADE.md` on `main` but is not present~~
  **resolved**: the canonical policy file (with the AUTONOMOUS tier
  documented) is restored by this PR, together with the `AUTONOMY_POLICY.md`
  contract and the rules/adapter alignment that reference it.
- `sharp` install scripts blocked by npm policy locally — only affects optional remote-UI
  image tooling; if a phase needs it, use the documented approval path (`npm install-scripts approve`).
- Windows full-suite local parallelism flakes (P2 debt, reconciliation report §8) — run
  required suites serially when validating PR-4 locally.
- Local `smallFix` failures (8/19) and the portable-golden CRLF failure are
  **fixed at root** in this PR (stale mock fixture; raw-bytes source hash) —
  see "Test-environment classification" for the corrected analysis and the
  withdrawn earlier attribution.
- Evaluation runs (Phase 6) consume paid API quota — use fixed, budget-capped configurations
  and record actual spend in `docs/evals/DAILY_DRIVER_EVAL_V1.md`.

## Test-environment classification (2026-09-05)

Classification of the recurring local-vs-CI validation noise that interfered
with trustworthy PR certification during Phase 1 (full detail and evidence in
the 2026-09-05 verification rows):

| Class | Symptom | Rule |
| --- | --- | --- |
| Stale mock fixture (corrected 2026-09-05) | `smallFix` suite failed 8/19 locally. **Root cause was not missing credentials** (the tests use a fake key and a mocked `fetch`): the mock responses predated the exact-live-route policy and lacked the observed model identity `validateObservedModelId` now requires, so the runner refused the synthetic response. Fixed at root: the fixtures echo the model identity the runner actually sent — **19/19 pass** | Mock fixtures must satisfy the current runner contract; suites not wired into CI drift silently |
| Platform checkout artifact | portable-workflow golden byte-compare failed on CRLF checkouts. Root cause: the golden manifest hashes `workflow.ts` as raw file bytes, so a CRLF checkout could never reproduce the LF-committed hash. Fixed: hash EOL-normalized canonical content and normalize line endings in the file comparison — content drift still fails closed | Golden comparison pins canonical content, not checkout bytes |
| Parallel-interference flakiness | 7 suites fail only under full-suite parallelism on Windows, pass serially (documented P2 debt) | Run required suites serially locally; CI ordering is authoritative |
| Pre-existing-claim rule | "pre-existing" used to excuse failures | **A "pre-existing" claim is only valid when the same failure is reproduced on the appropriate control/base state (or equivalent recorded evidence exists)** — encoded in `CLAUDE.md`. Applied here: the 11/8 split was reproduced on the untouched pre-PR head before being claimed pre-existing; the earlier "passes in CI" remark was unsupported (the suite is not wired into CI) and is withdrawn |

## Handoff

Each phase closure records: (a) outcome, (b) changed files, (c) test results,
(d) highest-value next move — per the repo's goal-clearance rules.
