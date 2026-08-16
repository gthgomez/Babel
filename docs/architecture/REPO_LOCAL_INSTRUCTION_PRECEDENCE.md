<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->


<!--
status: ACTIVE
last_verified: 2026-08-15
-->
# Repo-Local Instruction Precedence

## Purpose

This document defines how Babel should work with repo-local instruction surfaces such as:

- `AGENTS.md`, `CLAUDE.md`, `PROJECT_CONTEXT.md` (or equivalent agent-startup files)
- provider-specific repo instructions (e.g. per-harness startup files)
- repo-local skills/configuration
- `LLM_COLLABORATION_SYSTEM/` where a repo carries one

Not every repository carries every surface — precedence rules apply to whichever repo-local
surfaces exist.

## Short Answer

Babel and repo-local instruction surfaces overlap in purpose, but they operate at different
authority levels:

```text
Babel owns harness policy and selected cross-project instruction behavior.

The target repository owns repository-specific facts, invariants, startup
requirements, and local constraints.

Repo-local instructions may specialize behavior but must not grant authority
beyond Babel's runtime policy.
```

## Roles

### Babel

Babel is the cross-project control plane.

It is responsible for:
- entrypoint invocation
- harness policy (tools, permissions, completion, evidence, verification)
- stack selection (Prompt OS layers)
- model and adapter selection
- optional task overlays
- cross-project consistency

### Repo-Local Instruction Surface

A repo-local instruction surface is the execution contract for one repository.

It is responsible for:
- repo-specific startup order and facts
- project invariants
- local risk zones
- handoff rules inside that repo
- repo-specific model/runtime guidance

## Why Both Exist

Babel is reusable across projects.

A repo-local surface exists because each project has:
- different invariants
- different hot paths
- different risk zones
- different local operating contracts

Trying to put all of that into Babel would make Babel too project-specific.

Trying to put all cross-project guidance into each repo would create duplication and drift.

## Standard Handoff Order

When the target repo has a local instruction surface, use this order:

1. Read Babel's `BABEL_BIBLE.md`.
2. Use Babel to select the stack.
3. Read the target repo's `PROJECT_CONTEXT.md` (or equivalent startup file).
4. Read the repo-local startup chain (agent instruction files present in the repo).
5. Follow any repo-local startup chain from there.
6. Plan and act using the combined instruction set.

## Precedence Rules

### Rule 1

Babel decides the cross-project operating mode and harness policy.

Examples:
- which domain architect applies
- which model adapter applies
- whether task overlays apply
- what the completion, evidence, and permission gates are

### Rule 2

The repo-local surface decides repo-specific invariants.

Examples:
- auth boundary ownership
- local startup order
- project hot paths
- repo-specific guard rails

### Rule 3

If Babel guidance conflicts with a repo-local invariant, the repo-local invariant wins for
that repo — **but repo-local instructions cannot grant authority beyond Babel's runtime
policy** (they may specialize behavior; they may not weaken tool/permission/completion gates).

### Rule 4

Repo-local surfaces should not silently weaken Babel's higher-level behavioral discipline
unless intentionally designed to do so.

## Practical Division Of Responsibility

| Concern | Babel | Repo-Local Surface |
|---|---|---|
| Cross-project invocation | Yes | No |
| Harness policy (tools, permissions, completion) | Yes | No |
| Model/tool posture | Yes | Partial |
| Domain selection | Yes | No |
| Project invariants | No | Yes |
| Repo startup order | No | Yes |
| Local hot paths and risks | No | Yes |
| Optional task overlays | Yes | Partial |

## Current Recommended Pattern

Use Babel first.

Then let the repo-local surface take over the repo-specific portion of the startup sequence.

This means Babel should point the model toward the repo-local surface, not replace it.

## Example: Frontend Project Work

Correct chain:

1. Babel selects:
   - Behavioral OS
   - `domain_swe_frontend`
   - model adapter
   - project overlay
   - optional frontend task overlays
2. The project-local surface adds:
   - local startup order
   - auth boundary invariant
   - fail-closed risk boundaries for critical edge functions
3. The model plans and codes with both in view.

## Anti-Patterns

Do not:
- use Babel and skip the repo-local surface
- treat the repo-local surface as a replacement for Babel
- duplicate the entire Babel stack inside every project repo
- let Babel guess repo-local rules that already exist in the project surface
- let repo-local instructions claim authority over Babel runtime gates (credentials, destructive
  operations, completion/verification authority)

## Operational Rule

If a project contains both Babel usage and repo-local instruction files, the safe default is:

1. use Babel to choose the stack and harness policy
2. use the local instruction surface to finalize repo-specific startup and invariants

## Related Files

- [BABEL_BIBLE.md](../../BABEL_BIBLE.md)
- [RUNTIME_MODES.md](./RUNTIME_MODES.md)
