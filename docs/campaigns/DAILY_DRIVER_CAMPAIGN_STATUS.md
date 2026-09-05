<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-09-04
-->

# Daily Driver Campaign — Status

Living status document. Updated at each phase boundary and before any PR is opened.

- Campaign: Reconciled Platform → Exceptional Daily Coding Agent
- Baseline: [DAILY_DRIVER_CAMPAIGN_BASELINE.md](./DAILY_DRIVER_CAMPAIGN_BASELINE.md)
- Plan: [DAILY_DRIVER_CAMPAIGN_PLAN.md](./DAILY_DRIVER_CAMPAIGN_PLAN.md)
- Working branch: `agent/daily-driver` (clean worktree from `origin/main`)
- Baseline SHA: `015c7b374a3b2e67f7a5814508db0bd7f14ed263`

## Phase Tracker

| Phase | Scope | State | PR | Notes |
| --- | --- | --- | --- | --- |
| 0 | Baseline audit | **COMPLETE** (2026-09-04) | — | GitHub state + 5 deep audits reconciled against `main` @ `015c7b3` |
| 1 | Model Intelligence operator surface | **IN PROGRESS** — implementation complete, validation underway | PR-1 | `/model show\|why\|health`, truthful status bar/header, `/status` provider+fallback rows, `babel models list`; see Verification Log |
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

### Repairs included in PR-1

- `config.modelInvalidate.test.ts` expected the superseded model id
  `deepseek/deepseek-v4-flash`; canonical `config/model-policy.json` pins the dated
  revision `deepseek/deepseek-v4-flash-0731`. Expectation aligned with the canonical
  policy (test was orphaned — `src/interactive/commands/` was not wired into any CI
  script; `test:unit` now includes the directory so CI runs it).

## Open Risks / Watch Items

- `sharp` install scripts blocked by npm policy locally — only affects optional remote-UI
  image tooling; if a phase needs it, use the documented approval path (`npm install-scripts approve`).
- Windows full-suite local parallelism flakes (P2 debt, reconciliation report §8) — run
  required suites serially when validating PR-4 locally.
- Evaluation runs (Phase 6) consume paid API quota — use fixed, budget-capped configurations
  and record actual spend in `docs/evals/DAILY_DRIVER_EVAL_V1.md`.

## Handoff

Each phase closure records: (a) outcome, (b) changed files, (c) test results,
(d) highest-value next move — per the repo's goal-clearance rules.
