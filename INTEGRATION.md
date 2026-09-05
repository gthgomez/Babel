<!--
Babel — Coding Agent
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Babel Integration Guide

## Purpose

This is the model-facing and integration-facing entrypoint for the canonical
public Babel repository.

The concise autonomy contract is [`docs/AUTONOMY_POLICY.md`](./docs/AUTONOMY_POLICY.md).
It defines what an agent should decide autonomously and which authority boundaries
still require the user; it does not replace runtime enforcement.

When a user says:

- "Use Babel"
- "Read the integration guide"
- "Read INTEGRATION.md"
- "Use the Babel system before doing the task"

the model should read this file first, then follow the public Babel workflow before planning or implementing anything.

If you are a human exploring the repo for the first time, start with `README.md` and `START_HERE.md` first. Come here when you want the invocation contract that another model, client, or wrapper should follow.

## Public Repo Root And First Read

Treat this repo root as:

`<YOUR_BABEL_REPO_ROOT>`

Minimum first-read chain:

1. `INTEGRATION.md`
2. `PROJECT_CONTEXT.md`
3. `README.md`
4. `prompt_catalog.yaml`

## What This Repository Truthfully Is

`gthgomez/Babel` is Babel's canonical public source: a local coding-agent harness
whose Prompt OS is the inspectable instruction/control architecture underneath.

Chat is the normal daily lane. Plan and Deep add progressively stronger planning
and governance.

Its primary public surface is the interactive coding-agent runtime:

- a conversational **chat** loop in the terminal (the default daily path)
- reviewable **plan** mode and governed **deep** mode for stronger gates
- multi-turn sessions with resume, checkpoints, cost tracking, and recovery
- permissioned file editing and verification inside real repositories

Supporting inspection surfaces include catalog validation, deterministic stack/manifest previews, read-only MCP inspection of the typed `v9` resolver lane, public examples and regression tests, and public release and secret-scan gates. These inspection tools work without model credentials; model-backed sessions require local provider setup.

For **runtime harness architecture** (Chat / Plan / Deep controllers, completion authority, isolation, verifiers), the normative document is `docs/architecture/HARNESS_ARCHITECTURE_V1.md`. Its one implementation sequence is `docs/architecture/HARNESS_HARDENING_ROADMAP_V1.md`. The daily interactive path is ChatEngine; Prompt OS layers and catalog remain documented in `docs/architecture/ARCHITECTURE.md` and `prompt_catalog.yaml`.

## Canonical Public Workflow

When using this repository, do this:

1. Read `PROJECT_CONTEXT.md`.
2. Read `prompt_catalog.yaml`.
3. Determine the target project.
4. Determine the primary task category.
5. Select exactly one domain architect.
6. Select zero or more skills.
7. Select the model adapter.
8. Select the project/task overlays when needed.
9. Compile `instruction_stack` plus `resolution_policy` into the ordered manifest preview.

For a deterministic no-credentials proof path, prefer:

- `pwsh -File tools\validate-public-release.ps1`
- `pwsh -File tools\resolve-local-stack.ps1 ...`
- `babel mcp`

## Local Run Discipline

For public onboarding, start with the runtime path:

1. install `babel-cli` dependencies
2. build `babel-cli` if you want the compiled `node dist` command path
3. start the interactive TUI: `node .\babel-cli\dist\index.js interactive` (or use `tools/run-babel-local-cli.ps1`)
4. configure a provider when you want model-backed sessions

The no-credentials proof path remains available at any time:

- `pwsh -File tools\validate-public-release.ps1`
- `pwsh -File tools\resolve-local-stack.ps1 ...`
- `babel mcp`

The canonical repository does **not** assume private lifecycle scripts, private
run-artifact trees, private activation contracts, or files from a parent
workspace. Consumer-specific rules and overlays are optional external inputs.

Babel's public vision is a trustworthy local coding agent whose operating instructions stay inspectable, testable, and safe to integrate before and during model-backed execution.

## What Babel Is

Babel is an open-source, local coding-agent harness. Its daily interface is an interactive terminal session — chat by default, with plan and deep modes for stronger gates — that gives a model the context, tools, permissions, and verification needed to work inside a real repository.

The harness is powered by an inspectable Prompt OS underneath. It separates:

- behavioral rules
- domain expertise
- reusable skills
- model-specific tuning
- project overlays
- task overlays

The `v9` lane emits typed routing intent. The resolver/compiler turns that into the ordered manifest preview and final `prompt_manifest`.

## Canonical Source Of Truth

Use these files in this order:

1. `PROJECT_CONTEXT.md`
2. `prompt_catalog.yaml`
3. `00_System_Router/OLS-v9-Orchestrator.md`
4. the resolved prompt files selected from the catalog

In this repository, manifest selection is governed by the catalog plus the
resolver/compiler surfaces included here. If a cataloged file is missing on disk,
treat that as a system integrity problem.

## Layer Model

The Babel stack is:

1. `01_Behavioral_OS`
2. `02_Domain_Architects`
3. `02_Skills`
4. `03_Model_Adapters`
5. `05_Project_Overlays`
6. `06_Task_Overlays`
7. optional pipeline stages

## Evidence Rule

Use capability-aware evidence gathering:

- If the environment has file or repo access, inspect files directly.
- If the environment does not have file access, request the required files.
- Never pretend to know unseen file contents.

## Non-Negotiable

- Do not invent prompt files that are not in the catalog unless explicitly asked to author new Babel files.
- Do not use more layers than necessary.
- Do not let optional overlays weaken stronger layers.
