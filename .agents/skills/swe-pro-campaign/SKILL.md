---
name: swe-pro-campaign
description: >
  Run SWE-Bench Pro (and Gate 0 measurement) campaigns the reliable way:
  preflight → authorize → detached start → non-blocking monitor → max-data
  harvest → triage. Use when running SWE-Pro cells, Gate 0 mock/canary,
  remeasure, Wave A, or any multi-cell agent campaign that must not die to
  accidental outer timeouts. Slash: /swe-pro-campaign.
---

# /swe-pro-campaign

Durable operator runbook for Babel SWE-Bench Pro campaigns. Maximizes evidence
per dollar and **forbids accidental campaign death** from short agent-tool
timeouts.

## Contract

```
preflight → authorize → start (detached) → monitor → harvest → triage → declare
```

Scripts (repo-relative):

| Step | Command |
|------|---------|
| preflight | `pwsh babel-cli/scripts/preflight_swebench_pro.ps1 -EvidenceDir <dir> [-Dataset <path>]` |
| start | `pwsh babel-cli/scripts/start_swebench_pro.ps1 -Profile <name> -Dataset <path> -EvidenceDir <dir>` |
| monitor | `pwsh babel-cli/scripts/monitor_swebench_pro_live.ps1 -EvidenceDir <dir>` |
| harvest | `pwsh babel-cli/scripts/harvest_swebench_pro.ps1 -EvidenceDir <dir>` |

Profiles: see `references/profiles.md`.

## Triggers

| Input | Behavior |
|-------|----------|
| `/swe-pro-campaign` | Print phases + ask which profile |
| `/swe-pro-campaign preflight` | Run measurement-plane preflight only |
| `/swe-pro-campaign start gate0-mock` | Detached mock 3-cell (after preflight) |
| `/swe-pro-campaign start gate0-canary` | Detached 1-cell live (needs explicit user OK) |
| `/swe-pro-campaign monitor <evidence>` | One-shot status JSON |
| `/swe-pro-campaign harvest <evidence>` | Max-data pack + harvest-summary.md |
| "run SWE-Pro", "Gate 0 mock", "live canary", "detached campaign" | Same skill |

## Hard rules (non-negotiable)

1. **Live spend requires explicit user authorization** in this session. Do not start `gate0-canary`, `remeasure-3`, or `waveA-20` without a clear “go”.
2. **Never** run multi-cell live (or long mock with dep install) under a blocking tool whose timeout is shorter than the campaign wall.
3. **Always detach** for live and for mock when `limit≥1` and deps may install. Agent session only runs start/monitor (seconds). Use `start_swebench_pro.ps1` (Win32_Process.Create) — plain `Start-Process` / blocking `npm run` under an agent tool will be killed or timeout.
4. **Campaign process may run unbounded; cells must not.** Per-cell agent/ftp budgets come from the profile. Cell expiry → honest timeout class, then continue.
5. **Never** set `BABEL_DEEPSEEK_THINKING=disabled` “to make tools work” unless the profile is an explicit contrast arm, recorded in harvest.
6. **Never** claim model capability from env/harness/readiness blocks.
7. Evidence lives under `runs/` (gitignored). Status docs link relative paths only; no keys, no raw provider payloads.
8. On `exited_without_report`, triage partial cells + logs; do **not** invent pass rates.
9. Prefer Python **≥3.11** measurement plane (Docker). Host and default WSL 3.10 are known-bad for `typing.Required`.
10. Pass mode for honesty campaigns: `BABEL_SWE_PRO_PASS_MODE=both`.

## Timeout contract (“no accidental timeout”)

| Layer | Policy |
|-------|--------|
| Agent tool / session | Only `start` + `monitor` (seconds). Never `await` full campaign. |
| Campaign process | Detached; no parent kill. PID in `process.json`. |
| Per-cell agent | Profile wall (`--agent-timeout-ms`). `0` = disable this deadline only; product cost/turns still apply. |
| Per-cell fail-to-pass | Profile wall (live default 15m). Expiry → `fail_to_pass_class=timeout`. |
| Outer operator soft deadline | Notification only; prefer SIGTERM **between** cells if implemented later. |

Absolute zero wall-clock limit is impossible for live LLMs. The skill guarantees **zero accidental outer death** and **honest per-cell budgets**.

## Phase details

### 1. preflight

```powershell
pwsh -NoProfile -File babel-cli/scripts/preflight_swebench_pro.ps1 `
  -EvidenceDir runs/agent-benchmark/swe-pro/preflight-<stamp> `
  -Dataset benchmarks/datasets/swe-bench-pro/phase2-remeasure-2.jsonl
```

Requires `ok=true` in `preflight-receipt.json` before any live profile.

Checks: Docker (optional but recommended), Python ≥3.11 probe if available, dataset exists, git, path-length warning, credential presence boolean for live (never print secret).

### 2. authorize (live only)

Before start, state:

- profile name
- model id
- limit
- estimated upper bound (limit × cell cost ceiling)
- thinking default (enabled unless contrast arm)
- evidence dir

Wait for user confirmation.

### 3. start (detached)

```powershell
pwsh -NoProfile -File babel-cli/scripts/start_swebench_pro.ps1 `
  -Profile gate0-mock `
  -Dataset benchmarks/datasets/swe-bench-pro/phase2-remeasure-2.jsonl `
  -EvidenceDir runs/agent-benchmark/swe-pro/gate0-mock-<stamp>
```

Returns immediately with PID + evidence path. Do not wait for completion in the same tool call.

### 4. monitor (non-blocking)

```powershell
pwsh -NoProfile -File babel-cli/scripts/monitor_swebench_pro_live.ps1 `
  -EvidenceDir <evidence>
```

Status values: `running` | `complete` | `exited_without_report` | `not_started`.

For long watches, use the environment’s Monitor tool to poll, or return later. **Never** sleep-loop inside a short-timeout shell.

### 5. harvest (max data)

```powershell
pwsh -NoProfile -File babel-cli/scripts/harvest_swebench_pro.ps1 `
  -EvidenceDir <evidence>
```

Required pack (present or explicit N/A in summary):

1. `campaign-report.json`
2. final `heartbeat.json`
3. `process.json`
4. per-cell `infra/*.json`, `live/*.json`, patches
5. `policy-events.jsonl`
6. readiness / dep / test_patch / verifier_overlay notes
7. dual scoreboard (`gold_diff_ok`, `fail_to_pass_ok`, `fail_to_pass_class`)
8. invocation metadata (effort, thinking, cache-split) when present
9. `preflight-receipt.json` if copied into evidence
10. `harvest-summary.md` (generated)

### 6. triage

Classify every non-pass cell before proposing fixes:

| Class | Treat as |
|-------|----------|
| ENV / dep / python / collect pre-agent | **Environment** — not model |
| readiness_block / missing receipt | **Harness** |
| agent:harness_timeout | **Budget** — raise profile wall or product caps intentionally |
| BLOCKED_POLICY / BLOCKED_EXTERNAL with zero production edits | **Arbitration / honesty** — not a solve |
| gold_diff false + ftp assert_fail | **Model / task** candidate |
| false complete (claimed done, verifier disagree) | **Highest severity harness bug** |
| exited_without_report | **Operator / outer process** failure |

### 7. declare (Gate 0 only)

After `gate0-mock` + authorized `gate0-canary` harvests:

- Update `docs/status/BABEL_RELIABLE_EXECUTOR_ACCEPTANCE_*.md` with paths, classification table, capability matrix `observed_at`.
- Say **Gate 0 EXIT** only if mock finished with honest classes + working interpreter plane + canary shows non-handicapped thinking/effort wire.

## Gate 0 sequence (default when closing measurement truth)

1. Land Wave 0 implementation commit if still dirty.
2. `/swe-pro-campaign preflight`
3. `start gate0-mock` → monitor → harvest
4. User authorizes live → `start gate0-canary` → monitor → harvest
5. declare Gate 0

## Profiles quick reference

| Profile | provider | limit | Spend | Purpose |
|---------|----------|-------|-------|---------|
| `gate0-preflight` | — | 0 | $0 | Plane only |
| `gate0-mock` | mock | 3 | $0 | Mechanism smoke |
| `gate0-canary` | live | 1 | low | Wire/config proof |
| `remeasure-3` | live | 3 | med | Post–Gate 0 remeasure |
| `waveA-20` | live | 20 | high | Promotion (needs resume) |
| `infra-only` | mock | N | $0 | Checkout only |

Full flags: `references/profiles.md`.

## Integration

| System | Hook |
|--------|------|
| Wave 0 / Gate 0 exit | This skill is the operator path |
| Wave 5 statistical campaign | Same skill, `waveA-20` + future resume |
| `benchmark-triage` | Use for agent/vagueness benches; SWE-Pro classes live here |
| Detached scripts | `start_swebench_pro.ps1` supersedes live-only starter for new runs |

## Anti-patterns

- Blocking `npm run benchmark:agent:swe-pro -- --provider live --limit 20` inside an agent turn
- Claiming “DeepSeek cannot solve X” from Python 3.10 / MSYS / long-path failures
- Thinking-off live canary as the only arm without labeling handicap
- Publishing pass rates from partial heartbeat without `campaign-report.json`
