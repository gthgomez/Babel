# Babel Reliable Executor Acceptance Evidence (2026-08-02)

<!--
status: ACTIVE
scope: acceptance-validation
-->

This is an evidence record for the landed W3–W7 executor slices. It does not
promote a wave to complete: the roadmap still requires live benchmark,
fault-injection, restart/git, and deterministic cross-mode evidence.

## Local verification

| Check | Result |
| --- | --- |
| `cd babel-cli && npx tsc --noEmit` | PASS |
| Roadmap acceptance corpus (35 files) | **261 pass, 0 fail, 2 TODO; 263 tests** |
| Daemon integration standalone | PASS: lifecycle + clean restart/recovery |
| Verified-completion artifact validation | PASS: schema/example contract |
| Full `npm test` | INCONCLUSIVE: exceeded 180-second local timeout without a result |

Additional acceptance checks run after the original evidence record:

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run test:progress-ablation` | PASS: deterministic; no false completes |
| Executor fault-injection harness | PASS: 30/30 fault/effect cases; 0 duplicate mutations |
| Daemon + verified-completion focused tests | PASS: 6/6 |
| Absolute-path SWE-Pro infra preflight | PASS: 1/1 checkout |
| Absolute-path mock SWE-Pro cell | INCONCLUSIVE: no completed campaign report within the bounded runner window |
| DeepSeek V4 Flash live cell | HONEST FAILURE: `test_patch_applied=true`, `collect_error`, no authoritative completion; campaign timed out before the remaining cells finalized |
| DeepSeek wire/continuity conformance | PASS: focused provider-message, reasoning-content, thinking/tool-choice, effort-normalization, and cache-split tests |
| Readiness receipt + verifier overlay | PASS: signed redacted receipt blocks provider spend when absent; detached overlay excludes the test patch and preserves the primary workspace |
| Fresh three-cell mock SWE-Pro revalidation | HONEST BLOCK: 3/3 infra cells passed; 2/3 cells reached signed readiness + detached verification but produced zero production edits and terminal `BLOCKED_POLICY`/`BLOCKED_EXTERNAL`; 1/3 remained `ENV_BLOCKED` because Python 3.10 lacks `typing.Required` |

The focused corpus covers verifier authority and false-complete rejection,
Chat completion payloads, SessionEventV1, tool settlement, progress and
ablation, workspace/effect reconciliation, evidence graph and independent
verification, server-owned sessions, daemon lifecycle/recovery, and
Chat/Plan/Deep kernel parity.

The fresh mock revalidation also confirmed native Windows `Scripts` venv
selection and short per-instance workspace paths. It did not produce a model
capability score: the ready mock cells exercised harness arbitration with no
production patch, while the remaining cell was blocked by the host Python
version before provider execution.

## Changes made during acceptance closure

- Added the published verified-completion schema and example required by the
  W6 validation contract.
- Made the daemon TCP port configurable through `BABEL_DAEMON_PORT` so tests
  can coexist with another local Babel daemon.
- Hardened daemon integration timing and shutdown waits for Windows/tsx load.

## Remaining wave-exit evidence

- W1: adversarial corpus plus fresh benchmark-worktree revalidation.
- W2: kill/resume fault injection for every effect class.
- W3: fixed-baseline ablation metrics and end-to-end terminal arbitration.
- W4: restart/git patch reality and partial-failure integration.
- W5: real-daemon replay/resume/cancel matrix.
- W6: fresh revision-bound proof wired on every production completion path.
- W7: deep/lite bypass closure and deterministic Chat/Plan/Deep E2E.

## Live benchmark disposition

The live lane used the explicit `deepseek-v4-flash` model ID with tool-compatible
thinking disabled and `BABEL_SWE_PRO_PASS_MODE=both`. The DeepSeek credential was
read only by the provider environment; no key or raw provider payload is part of
this record. The first completed cell produced an honest verifier collection
failure, not a false green. The three-cell current-vs-baseline campaign and
Wave-A promotion remain blocked until the campaign runner completes within a
repeatable outer timeout; the preflight and dependency/workspace lifecycle need
further bounded-runner investigation before spending more live budget.

Latest Wave 0 disposition: no live provider call was made during this
revalidation. The next parity step is a Linux/container-backed SWE-Pro
preflight (Python 3.11+ and a short `/app`-style workspace), followed by the
same three-cell mock gate and only then an explicitly authorized live canary.

## Gate 0 operator path (2026-08-03)

Implementation landed on `codex/reliable-executor-acceptance`:

| Commit | Content |
| --- | --- |
| `47b72c8` | Wave 0 measurement truth + `/swe-pro-campaign` skill |
| `07c9f86` | Detached campaigns via `Win32_Process.Create` (Job Object escape) |

### Preflight

- Receipt: `runs/agent-benchmark/swe-pro/preflight-gate0/preflight-receipt.json`
- `docker_python311_ok=true` (python:3.11-slim → 3.11.15)
- Host Python remains 3.10 (`typing.Required` unavailable on host)

### Detached `gate0-mock` (complete)

- Evidence: `runs/agent-benchmark/swe-pro/gate0-mock-20260802-200957`
- Campaign id: `2026-08-03T01-09-59-mock`
- Harvest: `harvest-summary.md` / `harvest-summary.json`
- **Outer reliability:** campaign finished with `campaign-report.json` (no accidental tool timeout)
- **Infra:** 2/2 `infra:ok` (openlibrary + qutebrowser)
- **Live mock:** 2/2 honest `agent:env_blocked` (zero false completes, zero provider spend)
  - openlibrary: venv built from host Python 3.10 → `ImportError: cannot import name 'Required' from 'typing'`
  - qutebrowser: collect fails on missing pytest plugins after install
- **Positive harness facts:** `test_patch_applied=true` (git_apply) on both live cells; dep install attempted; native `Scripts` venv paths used
- **Note:** report `pass_mode` recorded as `gold` — detached launcher now bakes `BABEL_SWE_PRO_PASS_MODE=both` into `launch.cmd` for subsequent runs

### Gate 0 exit status

| Criterion | Status |
| --- | --- |
| Wave 0 code landed | **PASS** |
| Detached finish + report | **PASS** |
| Honest classifications | **PASS** |
| Working Py≥3.11 agent/verify plane | **FAIL** (Docker probe OK; campaign still creates venvs with host 3.10) |
| Live DeepSeek conformance canary | **NOT RUN** (needs authorize + Py 3.11 plane) |
| Gate 0 overall | **PARTIAL** — operator skill works; measurement plane must inject Python 3.11 into dep preflight/venv before canary |

### Next

1. Prefer system Python 3.11+ for `runWorkspaceDepPreflight` (or document Docker-in-WSL workspace execution).
2. Re-run detached `gate0-mock` until live cells reach readiness (or honest non-Python blocks only).
3. Explicitly authorized `gate0-canary` (limit=1, thinking on).

## Python 3.11 preference re-mock (2026-08-03)

| Commit | Content |
| --- | --- |
| `8772e92` | Prefer/require Python 3.11+ for SWE-Pro venvs; recreate stale &lt;3.11 venvs |

Host now has Python **3.11.9** (`py -3.11`). Evidence:

`runs/agent-benchmark/swe-pro/gate0-mock-py311-20260802-202001`

| Cell | Result |
| --- | --- |
| infra ×2 | `infra:ok` |
| openlibrary live | **`dep_ready=true`**, venv = 3.11.9 `Scripts/python.exe`, signed readiness, verifier_overlay, fail_to_pass ran (`assert_fail`); mock agent still terminal non-solve (`agent:env_blocked` from in-agent progress policy, not preflight) |
| qutebrowser live | Still preflight `ENV_BLOCKED`: missing pytest plugins (`pytest-bdd`, `pytest-qt`, …) after requirements install — **not** a 3.10/`Required` failure |

**Cleared:** host Python 3.10 / `typing.Required` preflight doom path.  
**Remaining env:** qutebrowser plugin set; mock-agent arbitration noise on openlibrary.

## Plugin + signature fix re-mock (2026-08-03)

| Commit | Content |
| --- | --- |
| `278e4f6` | pytest.ini required_plugins install + empty_patch mislabel fix |
| `272f852` | PyQt5 soft-dep for qutebrowser conftest |
| `ea0312e` | Load babel-cli/.env for detached live profiles |

Evidence `gate0-mock-plugins-20260802-203634`:

| Cell | Result |
| --- | --- |
| openlibrary live | **`dep_ready=true`**, signature **`agent:empty_patch`** (correct; not env_blocked) |
| qutebrowser live | Plugins installed; then **`ModuleNotFoundError: PyQt5`** (addressed in `272f852`) |

Live **gate0-canary** not run: `DEEPSEEK_API_KEY` absent in env and `babel-cli/.env`.

## Readiness green remock (2026-08-03)

| Commit | Content |
| --- | --- |
| `7f20742` | Soft-pin `pytest>=7,<8` for qutebrowser `pytest_ignore_collect(path)` |

Evidence: `runs/agent-benchmark/swe-pro/gate0-mock-pytest7-20260802-204733`

| Cell | dep_ready | signature | fail_to_pass | notes |
| --- | --- | --- | --- | --- |
| openlibrary | **true** | `agent:empty_patch` | assert_fail (collect ok) | signed readiness + overlay |
| qutebrowser | **true** | `agent:empty_patch` | assert_fail (collect ok) | soft_deps: plugins + PyQt5 + pytest&lt;8 |

**Both cells reached readiness.** Mock agent produces zero production patch → honest `agent:empty_patch` (not env_blocked).  
**Gate 0 measurement substrate:** green for this 2-cell dataset.  
**Still open:** budget-authorized live `gate0-canary` (needs `DEEPSEEK_API_KEY`).
