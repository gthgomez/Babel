# ADR-002: Zod Cross-Stage Contracts

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
**Status:** Accepted  
**Date:** 2026-06-19  
**Deciders:** Babel team  

## Context

The four-stage pipeline passes structured data between stages: the Orchestrator emits a manifest, the SWE Agent consumes it to produce a plan, the QA Reviewer audits the plan and emits a verdict, and the Executor consumes the plan and verdict.

Without runtime validation, malformed LLM output from one stage could silently corrupt downstream stages. We needed a way to validate inter-stage data at runtime, not just at compile time.

## Decision

We use **Zod** (v4) for all cross-stage contract schemas, defined in `babel-cli/src/schemas/agentContracts.ts`. Every stage's output is validated against its schema before being passed to the next stage.

Key schemas:
- `OrchestratorManifestSchema` / `OrchestratorOutputSchema` — Stage 1 output
- `SwePlanSchema` / `ActionStepSchema` — Stage 2 output
- `QaVerdictSchema` / `FailureTagSchema` (27 tags) — Stage 3 output
- `ExecutorTurnSchema` / `ExecutorReportSchema` — Stage 4 output
- `PipelineModeSchema` (chat|plan|deep) — consolidated from legacy names (direct|verified|autonomous|parallel_swarm|manual)
- `TargetModelSchema` (deepseek-v4-pro|deepseek-v4-flash|qwen3|scout|nemotron|step-flash|qwen3-32b)

The `runWithFallback()` function in `execute.ts` applies the schema after each LLM call. If validation fails, the error is fed back to the model for retry, or the waterfall falls through to the next provider.

## Alternatives Considered

**TypeScript types only:** No runtime validation. LLM output is inherently unreliable — compile-time types catch nothing.

**JSON Schema + Ajv:** More portable but heavier dependency. Zod integrates better with TypeScript's type inference (`z.infer<>`).

**Hand-written validators:** Most control, but high maintenance burden. Zod's declarative API is more concise and self-documenting.

## Consequences

**Benefits:**
- Malformed LLM output caught immediately, not N stages later
- Zod's `.parse()` provides typed output (narrowed from `unknown`)
- Schema definitions serve as living documentation of the inter-stage API
- `FailureTagSchema` enum (27 values) enables structured error categorization

**Trade-offs:**
- Runtime validation overhead on every LLM response
- Schema evolution requires coordinated prompt file updates
- Zod v4 migration adds dependency management overhead

## Compliance

All new pipeline stages must define Zod schemas for their outputs. Schema changes must include test updates in `agentContracts.test.ts`. The `runWithFallback` wrapper must apply the schema before returning.
