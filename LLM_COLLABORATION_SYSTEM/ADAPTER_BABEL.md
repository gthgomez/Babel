# ADAPTER_BABEL.md - Project Invariants (Babel)

Purpose: Repo-specific invariants and risk boundaries for Babel (Typed Instruction Compiler).

## Repo Scope

- System Router: `Babel/00_System_Router/`
- Behavioral OS: `Babel/01_Behavioral_OS/`
- Domain Architects: `Babel/02_Domain_Architects/`
- Model Adapters: `Babel/03_Model_Adapters/`
- Meta Tools: `Babel/04_Meta_Tools/`
- Project Overlays: `Babel/05_Project_Overlays/`
- Catalog: `Babel/prompt_catalog.yaml`

## Critical Invariants

1. Preserve the live **dual-router** control plane: `OLS-v9-Orchestrator.md` is the default typed runtime lane in `babel-cli`, and `OLS-v8-Orchestrator.md` remains the compatibility fallback until migration is explicitly retired.
2. Preserve the typed v9 compilation path: `instruction_stack` plus `resolution_policy` must compile into `compiled_artifacts` and a mirrored root `prompt_manifest` without breaking downstream worker/QA/executor consumers.
3. Maintain strict separation between **Behavioral OS** (how the model acts), **Domain Architects** (task strategy and invariants), and **Skills** (reusable technical knowledge).
4. Any changes to `OLS-v7-Core-Universal.md` or `OLS-v7-Guard-Auto.md` must be treated as **GLOBAL BREAKING CHANGES** as they affect all downstream agents.
5. Ensure `prompt_catalog.yaml` remains the single source of truth for prompt versioning, routable IDs, and file paths.

## High-Risk Zones

- `Babel/00_System_Router/OLS-v9-Orchestrator.md`
- `Babel/00_System_Router/OLS-v8-Orchestrator.md`
- `Babel/babel-cli/src/pipeline.ts`
- `Babel/babel-cli/src/compiler.ts`
- `Babel/babel-cli/src/schemas/agentContracts.ts`
- `Babel/01_Behavioral_OS/*`
- `Babel/prompt_catalog.yaml`
- `Babel/04_Meta_Tools/Prompt_Compiler-v4.1.md`

## Context Sync

On completion of substantial runs, sync `PROJECT_CONTEXT.md` for drift in system topology or orchestrator behavior.
