<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# ADAPTER_BABEL.md - Project Invariants (Babel)

Purpose: Repo-specific invariants and risk boundaries for Babel (Typed Instruction Compiler).

## Repo Scope

All paths are relative to the Babel repo root:

- System Router: `00_System_Router/`
- Behavioral OS: `01_Behavioral_OS/`
- Domain Architects: `02_Domain_Architects/`
- Model Adapters: `03_Model_Adapters/`
- Meta Tools: `04_Meta_Tools/`
- Project Overlays: `05_Project_Overlays/`
- Catalog: `prompt_catalog.yaml`

## Critical Invariants

1. `OLS-v9-Orchestrator.md` is the **only live typed runtime lane** in `babel-cli`. Legacy V8 references are historical compatibility notes only — do not treat them as an active fallback. See root `CLAUDE.md` Critical Invariant #2.
2. Preserve the typed v9 compilation path: `instruction_stack` plus `resolution_policy` must compile into `compiled_artifacts` and a mirrored root `prompt_manifest` without breaking downstream worker/QA/executor consumers.
3. Maintain strict separation between **Behavioral OS** (how the model acts), **Domain Architects** (task strategy and invariants), and **Skills** (reusable technical knowledge).
4. Any changes to `01_Behavioral_OS/OLS-v11-Core-Unified.md` must be treated as **GLOBAL BREAKING CHANGES** as they affect all downstream agents.
5. Ensure `prompt_catalog.yaml` remains the single source of truth for prompt versioning, routable IDs, and file paths.

## High-Risk Zones

- `00_System_Router/OLS-v9-Orchestrator.md`
- `babel-cli/src/pipeline.ts`
- `babel-cli/src/compiler.ts`
- `babel-cli/src/schemas/agentContracts.ts`
- `01_Behavioral_OS/*`
- `prompt_catalog.yaml`
- `04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`

## Context Sync

On completion of substantial runs, sync `PROJECT_CONTEXT.md` for drift in system topology or orchestrator behavior.
