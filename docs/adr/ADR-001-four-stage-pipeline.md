# ADR-001: Four-Stage Pipeline Architecture

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
**Status:** Accepted  
**Date:** 2026-06-19  
**Deciders:** Babel team  

## Context

AI coding tools typically use a single-stage architecture: prompt → LLM response → execute. This is fast but has no safety checks between planning and execution. The model that generates the plan is the same model that executes it, with no independent verification.

Babel needed an architecture that provides safety verification while maintaining autonomy. The key insight: separate the concerns of routing/planning, reviewing, and executing into distinct stages, each with its own model selection, each independently verifiable.

## Decision

We implemented a **four-stage pipeline** with typed Zod contracts between stages:

1. **Stage 1 — Orchestrator:** Routes the task, selects the domain architect and skills, emits an `OrchestratorManifest` with the instruction stack to compile.
2. **Stage 2 — SWE Agent:** Produces a `SwePlan` (minimal action set) from the compiled instruction stack and task.
3. **Stage 3 — QA Reviewer:** Adversarially audits the plan against safety gates, grounding rules, and task requirements. Emits a `QaVerdict` (PASS/REJECT). On REJECT, loops back to Stage 2 with feedback (max `MAX_SWE_QA_LOOPS`).
4. **Stage 4 — CLI Executor:** Multi-turn tool execution loop. Each turn: compile context + history → LLM call → execute tool → append result. Up to `MAX_EXECUTOR_TURNS`.

An **Evidence Loop** wraps Stages 2-4: when the SWE Agent emits `plan_type=EVIDENCE_REQUEST`, the pipeline gathers additional context and re-enters Stage 2.

## Consequences

**Benefits:**
- Independent model selection per stage (Orchestrator uses fast models, QA uses thorough models, Executor uses capable models)
- Typed contracts between stages prevent malformed data from propagating
- Adversarial QA catches planning errors before filesystem modification
- Each stage can be tested, benchmarked, and improved independently

**Trade-offs:**
- Higher latency than single-stage (3-4 LLM calls minimum before first tool execution)
- More complex error handling (each stage can fail independently)
- Token cost multiplier (each stage has its own context window)
- Pipeline orchestration complexity (~3,400-line pipeline.ts coordinating state transitions, with 59 additional modules extracted into `pipeline/`)

## Compliance

All pipeline stages must emit output matching their Zod schema contract. Schema changes require co-evolution of the prompt file (per `CLAUDE.md` Critical Invariant #6). Stage boundaries are enforced in `runBabelPipeline()` in `babel-cli/src/pipeline.ts`.
