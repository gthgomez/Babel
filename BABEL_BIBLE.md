<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Babel Bible

## Purpose

This is the human-facing entrypoint for `Babel-public`.

When a user says:

- "Use Babel"
- "Read the Babel Bible"
- "Use the Babel system before doing the task"

the model should read this file first, then follow the public Babel workflow before planning or implementing anything.

## Public Repo Root And First Read

Treat this repo root as:

`<YOUR_BABEL_REPO_ROOT>`

Minimum first-read chain:

1. `BABEL_BIBLE.md`
2. `PROJECT_CONTEXT.md`
3. `README.md`
4. `prompt_catalog.yaml`

## What Babel-public Truthfully Is

`Babel-public` is a runnable public-safe control-plane subset.

Its strongest public surfaces are:

- catalog validation
- deterministic stack/manifest preview
- read-only MCP inspection of the typed `v9` resolver lane
- public examples and regression tests

The larger pipeline harness is included, but it is an advanced surface and may require local model tooling or credentials. Do not treat it as the canonical first success path.

## Canonical Public Workflow

When using Babel-public, do this:

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
- `npm run preview:manifest -- ...`

## Local Run Discipline

For public onboarding, start with the preview and validation flow above.

If you want to use the advanced runtime harness:

- install `babel-cli` dependencies first
- optionally build `babel-cli`
- use `tools/run-babel-local-cli.ps1` or invoke `babel-cli` directly

`Babel-public` does **not** assume private lifecycle scripts, private run-artifact trees, or private activation contracts.

## What Babel Is

Babel is a layered prompt operating system.

It separates:

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
4. `00_System_Router/OLS-v8-Orchestrator.md`
5. the resolved prompt files selected from the catalog

In `Babel-public`, manifest selection is governed by the catalog plus the resolver/compiler surfaces included in this repo. If a cataloged file is missing on disk, treat that as a system integrity problem.

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
