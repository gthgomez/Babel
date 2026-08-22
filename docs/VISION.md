# Babel Vision

Babel is an open-source agent harness for software work, with a structured
Prompt OS underneath.

The goal is to give a local coding agent a useful daily loop while making the
context, tools, permissions, instruction stack, and evidence explicit enough
that a human, a model, or another tool can inspect what will happen before
execution begins.

## Current State

This repository is Babel's canonical, community-safe public source.

What works today from a fresh clone:

- build the public CLI and start the interactive TUI
- use the default conversational **chat** loop, with **plan** and **deep** for stronger gates
- configure a local provider and run model-backed sessions when credentials are present
- inspect, resume, and recover work (sessions, checkpoints, `undo`)
- validate the public catalog and release surface
- preview the selected Prompt OS stack for backend, frontend, mobile, and other lanes
- inspect deterministic manifest previews from `prompt_catalog.yaml`
- run a read-only MCP control-plane server
- run public secret and scrub checks before release

What is available but more advanced:

- `babel run` with explicit pipeline flags
- experimental loopback remote serve
- workspace-specific execution policy and Docker isolation profiles

## Product Principles

1. **Preview before execution.** A user should be able to see the selected stack before a model acts.
2. **Smallest correct stack.** Babel should load the minimum useful instruction layers for a task.
3. **Catalog as contract.** Routable prompt files should be declared, validated, and testable.
4. **Repo-local truth wins.** Babel can choose a stack, but the target repo owns its invariants.
5. **Integration before mutation.** Read-only inspection surfaces should come before write-capable automation.
6. **Public-safe by default.** Community docs and examples must not depend on private paths, names, credentials, or local operator notes.

## Maintenance Priorities

Public contributions are evaluated against four ongoing priorities:

- **Onboarding:** clearer first-success flows, less setup ambiguity, better examples.
- **Resolver quality:** stronger stack selection, fewer accidental layers, better conflict explanations.
- **CLI usability:** shorter commands, clearer diagnostics, stronger `doctor` output.
- **Release safety:** stronger source-integrity checks, scanner enforcement, and reproducible releases.

## Compatibility Principles

Babel is designed as a local coding-agent harness whose inspectable Prompt OS can integrate with editors, CLIs, MCP clients, other agents, and local workflows.

Public interfaces should remain:

- understandable enough for a new user
- strict enough for a maintainer
- modular enough for contributors
- safe enough for public reuse
- practical enough to run real software tasks when the local environment is ready

## What Belongs In Public

Good public content includes:

- prompt layers and skills useful across projects
- public-safe example overlays
- deterministic resolver examples
- CLI and MCP usage docs
- validation, scrub, and release evidence
- contribution guidance

What does not belong:

- private repo names or local machine paths
- secrets, tokens, credentials, or private package URLs
- scratch folders and run artifacts
- operator-only release notes
- docs that only make sense inside the private development lane

## Contribution North Star

If a change helps a new user understand, validate, inspect, or safely run Babel without private context, it probably belongs in Babel.

If a change only helps one consumer's private operations, keep it in that consumer
repository or its external configuration. Do not create a second source of Babel.
