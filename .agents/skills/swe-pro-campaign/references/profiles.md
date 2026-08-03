# SWE-Pro campaign profiles

Frozen operator defaults for `start_swebench_pro.ps1 -Profile <name>`.

Environment always set by starter unless profile overrides:

- `BABEL_SWE_PRO_PASS_MODE=both` (honesty dual scoreboard — **required for canaries**)
- Thinking left at product default (enabled) — do not set `BABEL_DEEPSEEK_THINKING=disabled` except contrast arm

**Canary honesty:** `gate0-canary` and `run_causal_live_canary.ts` force `pass_mode=both`. Never use gold-only for canaries: gold and host fail_to_pass are both reported; cell `status=pass` only when **both** green. Derived axes + improvement ledger remain authoritative for thrash diagnosis.

## Profile table

| Profile | Provider | Limit | Model | Agent timeout ms | Fail-to-pass ms | Early stop | Notes |
|---------|----------|-------|-------|------------------|-----------------|------------|-------|
| `gate0-preflight` | — | 0 | — | — | — | — | Script: preflight only; no campaign |
| `gate0-mock` | mock | 3 | (unused) | 1500000 (25m) | 900000 (15m) | 5 | Mechanism smoke; $0 |
| `gate0-canary` | live | 1 | **deepseek-v4-flash** | 1500000 | 900000 | 5 | Wire proof; **pass_mode=both**; user authorize |
| `remeasure-3` | live | 3 | **deepseek-v4-flash** | 0 (cell uses product caps; no harness kill) | 900000 | 5 | Post–Gate 0; authorize |
| `waveA-20` | live | 20 | **deepseek-v4-flash** | 0 | 900000 | 5 | Needs resume (Phase 2); authorize |
| `infra-only` | mock | 3 | — | — | — | 5 | `--infra-only` |

Timeout semantics:

- **Agent timeout `0`**: disables only the campaign harness subprocess deadline. Product chat cost/turn/wall still apply inside the agent.
- **Agent timeout `>0`**: outer kill after N ms → cell signature `agent:harness_timeout` when detected.
- Prefer **25m** for short canaries; prefer **0** for long exploratory cells once product ceilings are trusted.

## Suggested datasets

| Profile | Dataset (repo-relative) |
|---------|-------------------------|
| gate0-mock / canary / remeasure-3 | `benchmarks/datasets/swe-bench-pro/phase2-remeasure-2.jsonl` |
| waveA-20 | `benchmarks/datasets/swe-bench-pro/phase2-waveA-ordered.jsonl` |
| infra-only | any small JSONL |

## CLI expansion

Starter expands profiles to:

```text
npm run benchmark:agent:swe-pro -- \
  --provider <mock|live> \
  --model <id> \
  --limit <n> \
  --early-stop <n> \
  --agent-timeout-ms <n> \
  --fail-to-pass-timeout-ms <n> \
  --dataset <abs> \
  --evidence-dir <abs> \
  --heartbeat-file <abs>/heartbeat.json \
  --json
  [# optional --infra-only]
```

## Evidence layout

```text
<evidence>/
  process.json
  heartbeat.json
  campaign.stdout.log
  campaign.stderr.log
  campaign-report.json          # when complete
  preflight-receipt.json        # if copied/preflight ran into this dir
  harvest-summary.md            # after harvest script
  policy-events.jsonl
  infra/<instance_id>.json
  live/<instance_id>.json
  live/<instance_id>.patch
  workspaces/…                  # checkouts (may be large)
  verifier-overlays/…           # detached verify trees
```

## Resume (future)

When `--resume` lands on the campaign runner, `waveA-20` and long remeasures **must** pass the same `-EvidenceDir` and enable resume so completed cells are not re-spent.
