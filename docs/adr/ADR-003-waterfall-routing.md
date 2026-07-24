# ADR-003: Waterfall Routing (`runWithFallback`)

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
**Status:** Accepted  
**Date:** 2026-06-19  
**Deciders:** Babel team  

## Context

AI coding tools typically hardcode a single model per stage ("use Claude for planning, GPT-4 for execution"). This creates a single point of failure: if that provider is down, the pipeline fails. It also ignores that different models perform differently on different task types — a model that excels at Python refactoring may struggle with Gradle build configuration.

We needed a routing system that: (1) provides fallback on provider failure, (2) improves over time as we learn which models work for which tasks, and (3) supports per-stage model selection.

## Decision

We implemented **waterfall routing** via `runWithFallback()` in `babel-cli/src/execute.ts`.

Each pipeline stage has a **waterfall chain** — an ordered list of (provider, model) pairs, sourced from `config/model-policy.json`:
- **Orchestrator:** scout (Llama-4-Scout) → deepseek-v4-flash → qwen3-32b
- **Planning:** scout (Llama-4-Scout) → deepseek-v4-pro → step-flash → qwen3-32b
- **QA:** deepseek-v4-pro → nemotron → step-flash → qwen3-32b
- **Executor:** deepseek-v4-pro → deepseek-v4-flash → scout → qwen3-32b

On failure (schema validation, timeout, API error, empty response), the system falls through to the next tier. On success, the result is returned.

**Dynamic routing** (`routingEngine.ts`) scores waterfall tiers from historical telemetry stored in `05_waterfall_telemetry.json`. Formula: `winRate * 100 + priorBias + sampleBonus - avgAttempts * 10 - avgFallbacksBeforeWin * 5 - skippedFailures * 4`. Scores are cached process-wide.

## Consequences

**Benefits:**
- Single provider outage doesn't kill a run (graceful degradation)
- Telemetry-driven scoring improves routing over time (self-optimizing)
- Per-stage waterfalls allow different models for different concerns
- Generic `runWithFallback` wrapper handles retry, timeout, and schema validation uniformly

**Trade-offs:**
- Higher cost (failed attempts consume tokens)
- Higher latency (waterfall retries add round-trip time)
- Telemetry scoring adds complexity (scoring formula has 6 tunable parameters)
- Cold-start problem (new models have no telemetry, get default position)

## Compliance

Waterfall chains are defined in `config/model-policy.json` (single source of truth) and consumed by `execute.ts`. Adding a new model requires: adding it to the waterfall for the appropriate stage in `model-policy.json`, adding it to `TargetModelSchema`, and adding it to the model pricing registry.
