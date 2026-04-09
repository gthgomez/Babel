<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Contributing

## Setup

### Requirements

- Node.js 20+
- PowerShell 7+

### Install

```bash
git clone https://github.com/gthgomez/Babel.git
cd Babel/babel-cli && npm install && cd ..
```

### Verify the repo works

```powershell
pwsh -File .\tools\validate-public-release.ps1
```

### Type check

```bash
cd babel-cli && npx tsc --noEmit
```

---

## Scope

Babel is a prompt operating system, not a generic notes folder.

Treat changes to Babel like code changes:
- make the smallest correct change
- preserve layer boundaries
- update the catalog when required
- validate before opening a PR

## Before You Change Babel

Read:
1. [BABEL_BIBLE.md](./BABEL_BIBLE.md)
2. [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md)
3. [README.md](./README.md)
4. [prompt_catalog.yaml](./prompt_catalog.yaml)

If you are adding or changing prompt files, also read:
5. [Role_Creation_Gate.md](./04_Meta_Tools/Role_Creation_Gate.md)

## Layer Rules

- `01_Behavioral_OS`: universal behavior only
- `02_Domain_Architects`: broad primary expertise only
- `02_Skills`: reusable technical guidance loaded when the task needs it
- `03_Model_Adapters`: model-specific tuning only
- `05_Project_Overlays`: thin project context only
- `06_Task_Overlays`: optional reusable bounded guidance only

Do not put project invariants into model adapters.
Do not create new domain roles when an overlay is sufficient.
Do not treat generated memory files as authored sources of truth; they are downstream artifacts.

## Required Validation

From the Babel root:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\validate-catalog.ps1
```

If you touched routing, compiler, or load-order logic, also inspect:
- [OLS-v9-Orchestrator.md](./00_System_Router/OLS-v9-Orchestrator.md)
- [OLS-v8-Orchestrator.md](./00_System_Router/OLS-v8-Orchestrator.md)
- [prompt_catalog.yaml](./prompt_catalog.yaml)

Router state:
`OLS-v9-Orchestrator.md is the default typed runtime lane in babel-cli; OLS-v8-Orchestrator.md remains callable as the compatibility fallback until migration is explicitly retired.`

Use [README.md](./README.md) for the full validation matrix when your change touches runtime or tooling surfaces beyond the catalog.

## Prompt / Runtime Co-evolution Check

If your change touches `babel-cli/src/` — specifically `agentContracts.ts` or any `build*Task` function in `pipeline.ts` — run this checklist before opening a PR:

- [ ] Did I add a new field to a Zod output schema that the model must emit?
      → The corresponding prompt file must declare this field and its valid values.
- [ ] Did I add new instructions to a task builder function (`buildV9OrchestratorTask`, `buildSweTask`, `buildQaTask`, `buildExecutorTask`, etc.)?
      → The corresponding prompt file must include those instructions permanently, not just at runtime injection.
- [ ] Did I add a new enum value the model must choose from?
      → The prompt file listing that enum must be updated.

**If any box is checked and the prompt file was not updated, the change set is incomplete.**

See [GOVERNANCE.md](./GOVERNANCE.md) — "Prompt / Runtime Contract Co-evolution" for the full rule and trigger list.

## Pull Request Expectations

A good Babel PR should explain:
- what layer changed
- why the change belongs in that layer
- whether the change is reusable or project-specific
- whether any router/catalog behavior changed
- whether any `babel-cli/src/` changes require a corresponding prompt file update (co-evolution check)

## Suggested Commit Style

Examples:
- `router: add optional task overlay selection`
- `catalog: register balanced codex adapter`
- `overlay: add reusable frontend professionalism layer`
- `meta: add role creation gate`
