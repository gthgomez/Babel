# Lite Live Discovery Harness

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
Date: 2026-06-07

This guide documents the Lite discovery harness that exercises read-only and mutation routing across a seeded parity fixture repo and an optional real-world checkout.

## Purpose

Discovery complements the fix-only parity corpus (`test:live-parity-corpus`). It validates:

- Schema hardening for plan/report lanes (normalizers, grounding, retries)
- Interactive and CLI error parity (`LITE_SCHEMA_FAILED` vs misleading `TARGET_NOT_FOUND`)
- `bl do` routing with `--lite-only` on vague read-only and fix tasks
- Sequential review/undo after a scoped fix on the seeded repo

## Run commands

From repo root, after `npm --prefix .\babel-cli run build`:

```powershell
# Offline mock (default; no API keys required)
npm --prefix .\babel-cli run test:live-lite-discovery -- --provider mock

# Live provider (requires DEEPSEEK_API_KEY or DEEPINFRA_API_KEY in config)
npm --prefix .\babel-cli run test:live-lite-discovery -- --provider live --relic-run <path-to-project>
```

Evidence is written to `runs/live-lite-discovery/<timestamp>/` with per-scenario `stdout.log`, `stderr.log`, and a top-level `report.json`.

## Scenario matrix (11)

| ID | Target | Command shape | Acceptable statuses |
|----|--------|---------------|---------------------|
| `ask_concrete` | seeded | `ask --json` | `ANSWER_READY` |
| `ask_vague` | seeded | `ask --json` | `ANSWER_READY`, `NEEDS_MORE_CONTEXT` |
| `plan_concrete` | seeded | `plan --json` | `PLAN_READY`, `NEEDS_MORE_CONTEXT` |
| `plan_vague_relicrun` | external | `plan --json` | `PLAN_READY`, `NEEDS_MORE_CONTEXT` |
| `do_vague_readonly_relicrun` | external | `do --json --lite-only` | read-only lane statuses |
| `do_vague_fix` | seeded | `do --json --lite-only` | `FIX_COMPLETE`, `SMALL_FIX_COMPLETE`, `DO_COMPLETE` |
| `fix_scoped` | seeded | `fix --json` | `FIX_COMPLETE`, `SMALL_FIX_COMPLETE` |
| `propose_scoped` | seeded | `propose --json` | `PROPOSAL_READY`, `PATCH_READY`, `PATCH_COMPLETE` |
| `report_via_do` | seeded | `do --json --lite-only` | `REPORT_READY`, `ANSWER_READY`, … |
| `review_after_fix` | seeded | `review --json` | `REVIEW_READY`, `REVIEW_COMPLETE`, … |
| `undo_after_fix` | seeded | `undo --json` | `UNDO_COMPLETE` |

External project scenarios are **skipped** (not failed) when the project path is missing.

## Pass criteria

- Mock run: **11/11** pass (minus documented skips)
- No raw Zod validation text or `LITE_SCHEMA_FAILED` in human/JSON output for plan scenarios
- `do_vague_fix` completes via Lite small-fix (`FIX_COMPLETE` / `SMALL_FIX_COMPLETE`), not Full pipeline `EXECUTOR_HALTED`
- `npm --prefix .\babel-cli run test:lite-gate` stays green

## Provider modes

| Mode | API keys | Notes |
|------|----------|-------|
| `mock` | Not required | Sets `BABEL_LITE_OFFLINE=1`; injects `--provider mock` on `fix` and `do` |
| `live` | Required | Injects `--provider live` on `fix` and `do`; uses real model calls |

## Excluded modes

Discovery intentionally does **not** cover:

- `autonomous` repair loops
- `parallel_swarm` / Spark mutation subagents
- Worker-chain (`bl do --worker-chain`) — covered separately by runtime worker-loop tests

## Related guides

- [CLI command contract](../CLI_COMMAND_CONTRACT.md) — daily verb semantics

## Manual repro

```powershell
node .\babel-cli\dist\index.js plan "help me plan next features" --project-root <path-to-project> --json
```

Expect `PLAN_READY` or actionable `NEEDS_MORE_CONTEXT`, not a schema throw or misleading *"Choose an existing project root"* next step.
