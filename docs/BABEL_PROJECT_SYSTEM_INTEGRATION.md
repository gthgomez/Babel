# Babel Project System Integration

## Purpose

This document defines how Babel should work with repo-local collaboration systems such as:

- `LLM_COLLABORATION_SYSTEM/`
- project-local `AGENTS.md`
- repo-local model manifests and startup chains

The goal is to make the relationship explicit and repeatable.

## Short Answer

Babel and repo-local collaboration systems overlap in structure, but they should work together.

Use this rule:

`Babel chooses the cross-project stack; the repo-local system defines the repo-specific ground truth.`

## Roles

### Babel

Babel is the cross-project control plane.

It is responsible for:
- entrypoint invocation
- stack selection
- model and adapter selection
- optional task overlays
- platform-mode guidance
- cross-project consistency

### Repo-Local Collaboration System

A repo-local collaboration system is the execution contract for one repository.

It is responsible for:
- repo-specific startup order
- project invariants
- local risk zones
- handoff rules inside that repo
- repo-specific model/runtime guidance

## Why Both Exist

Babel is reusable across projects.

A repo-local system exists because each project has:
- different invariants
- different hot paths
- different risk zones
- different local operating contracts

Trying to put all of that into Babel would make Babel too project-specific.

Trying to put all cross-project guidance into each repo would create duplication and drift.

## Standard Handoff Order

When the target repo has a local collaboration system, use this order:

1. Read Babel's `BABEL_BIBLE.md`.
2. Use Babel to select the stack.
3. Read the target repo's `PROJECT_CONTEXT.md`.
4. Read the target repo's `LLM_COLLABORATION_SYSTEM/README_FOR_HUMANS_AND_LLMS.md`.
5. Follow any repo-local startup chain from there.
6. Plan and act using the combined instruction set.

## Precedence Rules

### Rule 1

Babel decides the cross-project operating mode.

Examples:
- which domain architect applies
- which model adapter applies
- whether task overlays apply

### Rule 2

The repo-local system decides repo-specific invariants.

Examples:
- auth boundary ownership
- local startup order
- project hot paths
- repo-specific guard rails

### Rule 3

If Babel guidance conflicts with a repo-local invariant, the repo-local invariant wins for that repo.

### Rule 4

Repo-local systems should not silently weaken Babel's higher-level behavioral discipline unless intentionally designed to do so.

## Practical Division Of Responsibility

| Concern | Babel | Repo-Local System |
|---|---|---|
| Cross-project invocation | Yes | No |
| Model/tool posture | Yes | Partial |
| Domain selection | Yes | No |
| Project invariants | No | Yes |
| Repo startup order | No | Yes |
| Local hot paths and risks | No | Yes |
| Optional task overlays | Yes | Partial |
| Platform-mode guidance | Yes | No |

## Current Recommended Pattern

Use Babel first.

Then let the repo-local system take over the repo-specific portion of the startup sequence.

This means Babel should point the model toward the repo-local system, not replace it.

## Example: GPCGuard Frontend Work

Correct chain:

1. Babel selects:
   - Behavioral OS
   - `SWE_Frontend`
   - model adapter
   - GPCGuard project overlay
   - optional frontend professionalism task overlays
2. GPCGuard local system adds:
   - local startup order
   - auth boundary invariant
   - fail-closed risk boundaries for critical edge functions
3. The model plans and codes with both in view.

## Anti-Patterns

Do not:
- use Babel and skip the repo-local system
- treat the repo-local system as a replacement for Babel
- duplicate the entire Babel stack inside every project repo
- let Babel guess repo-local rules that already exist in the project system

## Recommended Future Direction

Long term, project-local collaboration systems should become downstream runtime packs that are:
- generated from Babel-aligned layers
- enriched with project-specific invariants
- optimized for the local repo experience

That keeps:
- Babel as the source of reusable architecture
- project systems as the source of repo-local execution truth

## Operational Rule

If a project contains both:
- Babel usage
- a local `LLM_COLLABORATION_SYSTEM`

then the safe default is:

1. use Babel to choose the stack
2. use the local collaboration system to finalize repo-specific startup and invariants

## Related Files

- [BABEL_BIBLE.md](../BABEL_BIBLE.md)
- [BABEL_LOCAL_MODE.md](./BABEL_LOCAL_MODE.md)
- [VSCODE_MODEL_INVOCATION_GUIDE.md](./VSCODE_MODEL_INVOCATION_GUIDE.md)
- [BABEL_LOCAL_TOOLING_IMPROVEMENT_PLAN.md](./BABEL_LOCAL_TOOLING_IMPROVEMENT_PLAN.md)
