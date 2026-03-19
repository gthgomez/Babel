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

API Mode treats Babel as an operational control plane.

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

## API Mode Success Criteria

API Mode is ready when:
- stack resolution is deterministic
- router behavior is tested
- task outputs are observable
- approval boundaries are explicit
- regressions are caught before deployment
