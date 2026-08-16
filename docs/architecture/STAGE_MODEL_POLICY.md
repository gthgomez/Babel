<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
-->


<!--
status: ACTIVE
last_verified: 2026-08-15
-->
# Stage Model Policy

This document is a conceptual architecture reference for **stage model waterfalls**: what they
are, how fallback works, where policy lives, and what telemetry is allowed to influence.

**The mutable source of truth for current model rosters and waterfall orders is
`config/model-policy.json` — not this document.** Never hard-code current model lists into
documentation; inspect the policy file instead.

## What a stage waterfall is

The governed pipeline (`babel deep`) runs a sequence of stages — `orchestrator`, `planning`,
`qa`, `executor` — and each stage calls a provider lane via `runWithFallback(... stage: ...)`.
A **stage waterfall** is the priority-ordered list of eligible backend lanes for that stage:
`primary_backend_key` selects the preferred lane, `ordered_backend_keys` defines the fallback
chain when a lane fails (provider error, schema failure, timeout, budget).

Waterfalls are **per-stage**: the orchestration stage may prefer a cheap structural lane while
the QA stage prefers a stronger reasoning lane. This is policy, not architecture.

## How fallback works

`runWithFallback` advances down the stage's ordered lanes when a lane fails, and the pipeline
records fallback telemetry. Fallback is **resilience within configured eligibility** — it never
adds a lane that is not already listed in `config/model-policy.json`.

## Eligibility vs ranking vs reordering

Three distinct concepts must not be conflated:

| Concept | Definition | Who decides |
|---------|-----------|-------------|
| **Configured eligibility** | Which provider/model lanes may serve a stage at all | `config/model-policy.json` (`policy.blocked_without_explicit_opt_in`, per-family defaults, per-stage `ordered_backend_keys`) |
| **Bounded waterfall reordering** | Reordering the *tier order* of already-eligible lanes based on bounded telemetry | `babel-cli/src/routingEngine.ts` (min 3 stage-specific samples, recent-runs window, `BABEL_DYNAMIC_ROUTING=false` opt-out) |
| **Learned automatic task-to-model routing** | Automatically creating new eligibility or selecting providers from learned behavior | **Not claimed.** Current evidence supports tier reordering only; no evidence-backed learned router exists |

Telemetry may reorder eligible tiers within policy bounds. Telemetry does **not** grant new
authority and does **not** automatically create provider/model eligibility.

## Where policy lives

| Concern | File |
|---------|------|
| Stage waterfalls (`primary_backend_key`, `ordered_backend_keys`), tiers, family defaults, vendor aliases, blocked/expensive policy | `config/model-policy.json` |
| Policy resolution logic | `babel-cli/src/modelPolicy.ts` |
| Stage-aware policy consumption | `babel-cli/src/execute.ts` (`runWithFallback`) |
| Tier-order reordering from telemetry | `babel-cli/src/routingEngine.ts` |

## How to inspect current policy

```powershell
# Print the resolved backend model, provider ID, and approximate cost metadata for a run
babel run "inspect policy" --show-model-policy

# Direct inspection of the policy file
Get-Content .\config\model-policy.json
```

The `--show-model-policy` flag prints the resolved policy for the actual run; the JSON file is
the authoritative source for eligibility and ordering.

## What telemetry is allowed to influence

- **Tier order** within a stage's eligible lanes (routing engine, bounded by sample counts and
  run windows).
- **Cost-aware selection** (`--cost-optimize`) within configured eligibility.
- Nothing else. Provider/model **eligibility** itself is configuration-only.

## Related authority

- Normative runtime harness: [HARNESS_ARCHITECTURE_V1.md](./HARNESS_ARCHITECTURE_V1.md)
- Waterfall decision rationale: [ADR-003](../adr/ADR-003-waterfall-routing.md)
- Provider capability negotiation: [HARNESS_ARCHITECTURE_V1.md](./HARNESS_ARCHITECTURE_V1.md) §6.3.4
