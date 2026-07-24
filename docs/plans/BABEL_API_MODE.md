<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->


<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Babel API Mode

## Purpose

API Mode is the future automation-first runtime for Babel.

Use this mode when you want:
- programmatic routing
- automatic manifest assembly
- testable multi-step execution
- QA gates
- repeatable autonomous workflows

## What API Mode Is

API Mode is intended to treat Babel as an experimental governed runtime for prompt-stack resolution and bounded execution. It should not be described as an operational or production control plane until live provider-backed governance, verifier behavior, and run replay are proven with saved artifacts.

The system should be able to:
- receive a task
- classify it
- select the correct stack
- produce a manifest
- run a bounded workflow
- verify output
- log results

## What API Mode Is Not

API Mode is not just "calling the model with more tokens."

It requires:
- orchestration
- explicit safety gates
- persistent logs or artifacts
- validation and regression checks

## Target Architecture

Recommended shape:

1. Router
2. Stack resolver
3. Worker
4. Optional QA stage
5. Optional executor stage
6. Logging / eval / replay layer

## Core API Mode Principles

1. Keep Babel Core shared with Local Mode.
2. Add automation around Babel, not a second prompt architecture.
3. Prefer bounded workflows over fully open-ended autonomy.
4. Keep every automatic stage observable and testable.
5. Keep remote model use user-shaped: configured LLM providers are a normal execution path, while approvals are reserved for meaningful changes in cost, mutation, network side effects, enterprise policy, or unattended autonomy.

## Provider Context Boundary

When API Mode calls a remote LLM, Babel may send task text, selected prompt-stack layers, relevant file snippets, previous stage output, verifier results, and logs needed to complete the task. API Mode should make that boundary explicit in user-facing status and logs, but it should not treat ordinary configured provider use as an exceptional approval failure.

Approvals should be reserved for decisions the user would actually care about:
- unusually expensive or enterprise-blocked model routes
- dependency installation
- remote side effects such as creating PRs or publishing
- broad workspace mutation
- unattended autonomous execution

If the caller explicitly selects a provider/model/tier for a run, treat that as intent for the run unless enterprise policy forbids it.

## Recommended Runtime Concepts

- manifest generation
- stack resolution
- platform modes
- approval checkpoints
- replayable runs
- eval fixtures
- prompt regression tests

## Suggested Phases

### Phase 1

- manifest generation
- stack resolver
- catalog validation
- router fixtures

### Phase 2

- worker execution wrapper
- run logging
- basic success/failure classification

### Phase 3

- optional QA stage
- optional executor stage
- approval boundaries

### Phase 4

- evals
- release discipline
- richer policy enforcement

## Best Use Cases

- professional automation
- internal engineering workflows
- repeatable code review or planning pipelines
- routing tasks into the right instruction stack
- organization-level prompt governance

## API Mode Risks

- hidden costs if prompts expand too much
- over-automation without strong evals
- brittle assumptions if router logic is untested
- safety regressions if repo-local invariants are skipped
- skipped provider-backed tests if required API keys are absent
- overclaiming verifier-gated completion beyond the declared or inferred verifier contracts that actually apply

## API Mode Success Criteria

API Mode is ready when:
- stack resolution is deterministic
- router behavior is tested
- task outputs are observable
- approval boundaries are explicit
- regressions are caught before deployment
