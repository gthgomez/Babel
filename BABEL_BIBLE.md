# Babel Bible

## Purpose

This is the human-facing entrypoint for Babel.

If a user says:
- "Use Babel"
- "Read the Babel Bible"
- "Use the Babel system before doing the task"

then the model should read this file first and follow its workflow before planning or implementing anything.

## Repo Root And First Read

When a user says only "use Babel", treat this as the Babel repo root:

`<YOUR_PROJECT_ROOT>/Babel`

Minimum first-read chain for shorthand invocation:

1. `BABEL_BIBLE.md`
2. `PROJECT_CONTEXT.md`
3. `README.md`
4. `prompt_catalog.yaml`

Then continue with the standard Babel workflow and any selected prompt layers.

## Local Run Discipline

If you are using Babel through a local/editor/subscription surface, writing the run bundle under `runs/` is not enough.

Before work:
- use `tools/launch-babel-local.ps1`, or
- use `tools/start-local-session.ps1`

If you later run `babel run`, attach it to the same Local Mode session:
- set `BABEL_SESSION_ID`
- set `BABEL_SESSION_START_PATH`
- set `BABEL_LOCAL_LEARNING_ROOT`

`tools/launch-babel-local.ps1` now prints these exact env commands for copy/paste.

After work:
- use `tools/end-local-session.ps1`

Required Local Mode artifacts:
- `runs/local-learning/session-starts/<UTC-date>/`
- `runs/local-learning/session-ends/<UTC-date>/`
- `runs/local-learning/session-log.jsonl`

If those lifecycle artifacts are missing, the run is protocol-incomplete and should be treated as non-canonical for Local Mode learning and analytics.

Use `tools/report-run-consistency.ps1` to audit raw bundles against Local Mode lifecycle logging.

## What Babel Is

Babel is a layered prompt operating system.

It separates:
- behavioral rules
- domain expertise
- model-specific tuning
- project-specific constraints
- optional task-specific overlays

The goal is to assemble the smallest correct instruction stack for the task instead of loading one giant monolithic prompt.

## Canonical Source Of Truth

Use these files in this order of authority:

1. `PROJECT_CONTEXT.md`
2. `prompt_catalog.yaml`
3. `00_System_Router/OLS-v9-Orchestrator.md` for the default typed runtime lane
4. `00_System_Router/OLS-v8-Orchestrator.md` as the compatibility fallback lane
5. Any prompt files selected from the catalog or derived by the compiler

Catalog tags (including `always_load`) describe manifest selection — which files are assembled into the prompt stack. `LLM_COLLABORATION_SYSTEM/ACTIVATION_CONTRACT.yaml` governs behavioral gate enforcement — which assembled files actively apply their gates based on task context.

If a file is referenced by the catalog but missing on disk, treat that as a system integrity problem and note it explicitly.

## Standard Babel Workflow

When using Babel, do this sequence:

1. Read `PROJECT_CONTEXT.md`.
2. Read `prompt_catalog.yaml`.
3. Determine the target project.
4. Determine the primary task category.
5. Select exactly one domain architect.
6. Select zero or more skills if the task needs reusable technical guidance beyond the thin domain shell.
7. Select the model adapter that best matches the model and task shape.
8. Load the project overlay if the task belongs to a known project.
9. Load one or more optional task overlays only if they add clear value.
10. If using the v9 lane, compile typed routing intent into the final ordered `prompt_manifest`.
11. Enter PLAN or ACT according to the loaded behavioral rules.

## Layer Model

The Babel stack is:

1. `01_Behavioral_OS`
2. `02_Domain_Architects`
3. `02_Skills` when needed
4. `03_Model_Adapters`
5. `05_Project_Overlays`
6. `06_Task_Overlays`
7. Optional pipeline stages

Interpretation rules:
- Behavioral OS defines how the model behaves.
- Domain architects define task strategy, invariants, and default skill bundles.
- Skills provide reusable technical knowledge and should not replace domain selection.
- Model adapters tune style and execution shape, not policy.
- Project overlays add repository-specific constraints.
- Task overlays add optional, bounded guidance for a specific kind of work.

## When To Use Task Overlays

Use a task overlay only if it materially improves the task.

Good reasons:
- frontend professionalism and visual polish
- launch-readiness passes
- refactor-safety constraints
- copy-tone normalization

Bad reasons:
- to repeat what the domain architect already says
- to encode project invariants that belong in the project overlay
- to create a new domain role by stealth

## Reuse Principle

General rules should stay general.

Use this split:
- generic reusable guidance in `06_Task_Overlays`
- project-specific deltas in project-specific task overlays

Example:
- `06_Task_Overlays/Frontend-Professionalism-v1.0.md`
- `06_Task_Overlays/GPCGuard-Frontend-Professionalism-v1.0.md`

## Evidence Rule

Use capability-aware evidence gathering:

- If the environment has file or repo access, inspect files directly.
- If the environment does not have file access, request the required files or upload pack.
- Never pretend to know unseen file contents.

## Model Selection Guidance

Default model tendencies:
- Codex: execution-heavy work, refactors, deterministic repo edits
- Claude: higher-judgment reasoning, compliance, nuanced restructuring
- Gemini: long-context synthesis, log sweeps, document-heavy tasks

For Codex specifically:
- use `Codex_Balanced.md` for refactors, frontend work, and multi-file architecture edits
- use `Codex_UltraTerse.md` for highly constrained execution, schema generation, and dense algorithmic tasks

## Project Overlay Guidance

Project overlays should remain thin.

They should contain:
- project purpose
- tech stack
- hard invariants
- primary objects

They should not become giant task prompts.

## Task Overlay Guidance

Task overlays should contain:
- when to use
- bounded constraints
- quality bars
- anti-goals
- verification expectations

They should not redefine the entire behavioral system.

## If The User Says Only "Read The Bible Doc"

Interpret that as:

1. Use this file as the entrypoint.
2. Read `PROJECT_CONTEXT.md` and `prompt_catalog.yaml`.
3. Assemble the relevant Babel stack.
4. Follow the assembled stack before planning or doing work.

## Web-Only / No-Repo Mode

If you do not have local file access, request:
- `BABEL_BIBLE.md`
- `PROJECT_CONTEXT.md`
- `prompt_catalog.yaml`
- the selected prompt files from the manifest
- the relevant project files needed for the task

## Non-Negotiable

- Do not invent prompt files that are not in the catalog unless explicitly asked to author new Babel files.
- Do not use more layers than necessary.
- Do not let style overlays weaken project invariants or behavioral rules.
