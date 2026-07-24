# Parity Benchmark Fixture Guide

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
Date: 2026-06-06

This guide explains how to supply measured cells to `babel benchmark parity` without overstating claim readiness.

## What exists today

- **Task matrix:** 8 Phase 12 tasks × 3 tools (`babel`, `competitor_a`, `competitor_b`) via `babel benchmark parity`.
- **Babel automation (Wave 6):** Repeatable offline_demo cells for tasks 1–2:
  - `small_bug_fix`
  - `failing_test_repair`
- **Fixture corpus:** `babel-cli/src/fixtures/parity-corpus/`
- **Honest gate:** `summary.claim_ready` stays `false` until all 24 cells are measured **and** at least one comparison axis is `babel_stronger`. Mock/offline Babel cells alone do not unlock parity claims.

## Run Babel cells (tasks 1–2)

From repo root, after `npm --prefix .\babel-cli run build`:

```powershell
# Both tasks via bl fix (offline_demo fixture scope)
npm --prefix .\babel-cli run parity:run-babel -- --json

# Write a partial --fixture file for benchmark parity
npm --prefix .\babel-cli run parity:run-babel -- --output .\runs\parity-corpus\babel-cells.json

# Single task or worker-loop mode
npm --prefix .\babel-cli run parity:run-babel -- --task failing_test_repair --mode worker-loop --json
```

Evidence lands under `runs/parity-corpus/<task_id>-babel.json` by default.

## Run live Babel cells (all 8 tasks)

After `npm --prefix .\babel-cli run build` and provider keys in config:

```powershell
# All 8 tasks with live provider (requires DEEPINFRA_API_KEY or DEEPSEEK_API_KEY in config)
npm --prefix .\babel-cli run parity:run-babel -- --provider live --json

# Single task with live provider
npm --prefix .\babel-cli run parity:run-babel -- --task small_bug_fix --provider live --json

# Write live fixture for benchmark parity merge
npm --prefix .\babel-cli run parity:run-babel -- --provider live --output .\runs\parity-corpus\babel-cells-live.json

# Write parity --fixture JSON from live measured cells
npm --prefix .\babel-cli run test:live-parity-corpus -- --provider live --output .\runs\live-parity-corpus\babel-cells.json --json
```

Evidence lands under `runs/live-parity-corpus/<task_id>/`. Each run uses `fix --json --human-summary` so JSON scoring and human UX review share one provider call.

## Lite discovery vs parity corpus

| Harness | Scope | Command |
|---------|-------|---------|
| **Parity corpus** (`test:live-parity-corpus`) | Fix-only regression on tasks 1–2 | `fix --provider live` |
| **Lite discovery** (`test:live-lite-discovery`) | 11-scenario routing matrix (ask/plan/do/fix/propose/review/undo) on seeded + external project | See [Lite Live Discovery](./LITE_LIVE_DISCOVERY.md) |

Use parity corpus to score measured fix cells; use discovery to gate Lite routing, schema hardening, and interactive UX before broader releases.

For manual CLI runs, add `--human-summary` with `--json` to persist `human_summary.txt` without a second live invocation:

```powershell
node .\babel-cli\dist\index.js fix --json --human-summary --provider live --project-root <repo> "<task>"
```

## Supply `--fixture` for measured competitor cells

1. Run the **same repo state and task prompt** for every tool (see task definitions in the parity benchmark report).
2. Record per cell:
   - `status`: `success` | `failure` (never `manual_required` if actually measured)
   - `verifier`: `pass` | `fail`
   - `false_complete`: `true` if the tool claimed success without verifier pass
   - `latency_ms`, `cost_usd`, `token_count`, `changed_files`, `user_interventions`
   - `evidence_path`: path to saved logs/screenshots/artifacts
3. Merge measured fixture files with `parity:merge-fixture` (last-wins on `task_id` + `tool`):

```powershell
npm --prefix .\babel-cli run parity:run-babel -- --output .\runs\parity-corpus\babel-offline.json
npm --prefix .\babel-cli run test:live-parity-corpus -- --provider live --output .\runs\live-parity-corpus\babel-live.json --json
npm --prefix .\babel-cli run parity:merge-fixture -- .\runs\parity-corpus\babel-offline.json .\runs\live-parity-corpus\babel-live.json --output .\runs\parity-corpus\merged-cells.json
```

Manual merge shape (if not using the CLI):

```json
{
  "results": [
    {
      "task_id": "small_bug_fix",
      "tool": "babel",
      "status": "success",
      "verifier": "pass",
      "false_complete": false,
      "latency_ms": 1200,
      "cost_usd": null,
      "token_count": null,
      "changed_files": ["src/math.js"],
      "user_interventions": 0,
      "evidence_path": "runs/parity-corpus/small_bug_fix-babel.json",
      "notes": ["offline_demo fixture-scoped Babel cell"]
    },
    {
      "task_id": "small_bug_fix",
      "tool": "competitor_a",
      "status": "success",
      "verifier": "pass",
      "false_complete": false,
      "latency_ms": 45000,
      "cost_usd": 0.12,
      "token_count": 18000,
      "changed_files": ["src/math.js"],
      "user_interventions": 1,
      "evidence_path": "runs/parity-corpus/small_bug_fix-competitor_a.json",
      "notes": ["Measured in competitor with same seeded repo"]
    }
  ]
}
```

4. Generate the benchmark artifact:

```powershell
node .\babel-cli\dist\index.js benchmark parity --fixture .\runs\parity-corpus\merged-cells.json --json
```

Repeat until all **24** cells are measured before treating `claim_ready: true` as meaningful. Partial fixtures are expected during Wave 6; update the claims matrix with YELLOW progress notes only—do not promote parity to GREEN without ≥4/8 tasks with full external measurements.

## Product scorecard dimensions

Fixture-based internal scoring:

```powershell
npm --prefix .\babel-cli run benchmark:product -- --json
```

Dimensions added in Wave 6: `plan_mode`, `parallel_agent_review`, `restore_reliability` (checkpoint UX), `successful_task_completion` (verifier discipline). Inspect via:

```powershell
npx --prefix .\babel-cli tsx .\babel-cli\scripts\score_lite_feature.ts --json
```

## Related commands

| Command | Purpose |
| --- | --- |
| `npm --prefix .\babel-cli run parity:run-babel` | Run offline_demo Babel cells for parity tasks 1–8 |
| `npm --prefix .\babel-cli run test:live-parity-corpus` | Run live (or `--provider mock`) Babel cells for parity tasks 1–8 |
| `npm --prefix .\babel-cli run parity:merge-fixture` | Merge multiple `--fixture` JSON files with dedupe |
| `node .\babel-cli\dist\index.js benchmark parity --fixture <path>` | Generate parity artifact from merged fixture |
| `npm --prefix .\babel-cli run benchmark:product` | Product gap + Lite feature scorecard scenarios |
