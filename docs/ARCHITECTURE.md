<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Babel Architecture

## Overview

`Babel-public` exposes the control plane of Babel, not the private source repo around it.

The public repo is intentionally centered on:

- layered prompt composition
- typed `v9` routing intent
- catalog-driven resolver/compiler behavior
- deterministic manifest preview
- read-only inspection surfaces

That is why the public proof path is validation plus preview, not "trust us, the full pipeline works everywhere."

## The Layers

Babel stacks are assembled in this order:

1. Behavioral OS
2. Domain Architect
3. Skills
4. Model Adapter
5. Project Overlay
6. Task Overlay
7. Optional pipeline stages

## The Catalog

`prompt_catalog.yaml` is the source of truth for routable assets.

The resolver uses it to:

- validate IDs
- expand domain `default_skill_ids`
- expand skill dependencies
- reject conflicts
- produce the ordered manifest preview

## Public Resolver Flow

The public helper flow is intentionally catalog-driven:

1. choose a task category, project, model, and pipeline mode
2. build a typed `instruction_stack`
3. apply the default `resolution_policy`
4. resolve the final ordered manifest from the catalog

The easiest public entrypoints are:

- `pwsh -File tools\resolve-local-stack.ps1`
- `pwsh -File tools\validate-public-release.ps1`
- `babel mcp`

## The v9 Lane

The public v9 story is:

- the router contract emits `instruction_stack` plus `resolution_policy`
- the resolver/compiler expands that stack against `prompt_catalog.yaml`
- the compiled result mirrors an ordered `prompt_manifest`

This repo includes deterministic tests and golden previews for that path.

## Android / Mobile

Android is a real first-class routed lane in `Babel-public`.

Public proof:

- `domain_android_kotlin` is cataloged
- the mobile skills are cataloged
- `overlay_example_mobile_suite` is cataloged
- `tools/resolve-local-stack.ps1` supports `-TaskCategory mobile -Project example_mobile_suite`
- `examples/manifest-previews/mobile-direct.json` proves the mobile lane resolves end to end

## Read-Only MCP Surface

`babel mcp` is a read-only inspection surface.

It supports:

- catalog inspection
- instruction-stack preview
- manifest preview
- stack resolution

It is not a shell, execution, or file-mutation surface.

## Advanced Runtime Harness

The larger `babel-cli` pipeline is still present, but it is an advanced surface.

It may require:

- model credentials
- local model tooling
- explicit runtime configuration

That surface should be described as optional/advanced in public docs, not as the primary onboarding promise.

## Public Proof Artifacts

- [examples/manifest-previews/backend-verified.json](../../examples/manifest-previews/backend-verified.json)
- [examples/manifest-previews/mobile-direct.json](../../examples/manifest-previews/mobile-direct.json)
- `npm run test:resolver`
- `npm run test:mcp-adapter`
- `npm run test:orchestrator-routing`
