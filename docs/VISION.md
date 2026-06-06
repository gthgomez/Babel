# Babel Vision

Babel is a prompt operating system for software work.

The goal is not to hide prompts behind a black box. The goal is to make the instruction stack explicit enough that a human, a model, or another tool can inspect what will happen before execution begins.

## Current State

The public repo is a generated, community-safe release surface.

What works today from a fresh clone:

- validate the public catalog and release surface
- preview the selected stack for backend, frontend, mobile, game, research, compliance, and other task lanes
- inspect deterministic manifest previews from `prompt_catalog.yaml`
- run a read-only MCP control-plane server
- build and typecheck the public CLI
- run public secret and scrub checks before release

What is available but more advanced:

- model-backed `babel run`
- manual bridge and autonomous pipeline flows
- local provider configuration
- workspace-specific execution policy

## Product Principles

1. **Preview before execution.** A user should be able to see the selected stack before a model acts.
2. **Smallest correct stack.** Babel should load the minimum useful instruction layers for a task.
3. **Catalog as contract.** Routable prompt files should be declared, validated, and testable.
4. **Repo-local truth wins.** Babel can choose a stack, but the target repo owns its invariants.
5. **Integration before mutation.** Read-only inspection surfaces should come before write-capable automation.
6. **Public-safe by default.** Community docs and examples must not depend on private paths, names, credentials, or local operator notes.

## Near-Term Direction

Babel-public should keep improving in four lanes:

- **Onboarding:** clearer first-success flows, less setup ambiguity, better examples.
- **Resolver quality:** stronger stack selection, fewer accidental layers, better conflict explanations.
- **CLI usability:** shorter commands, clearer diagnostics, stronger `doctor` output.
- **Release safety:** stricter public export checks, scanner enforcement, and drift reporting.

## Longer-Term Direction

The long-term shape is a community prompt layer that can plug into editors, CLIs, MCP clients, coding agents, and local workflows.

That means Babel should become:

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

If a change helps a new user understand, validate, inspect, or safely run Babel without private context, it probably belongs in the public release.

If a change only helps private operations, keep it in the private source lane.
