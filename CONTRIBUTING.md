# Contributing

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

## Pull Request Expectations

A good Babel PR should explain:
- what layer changed
- why the change belongs in that layer
- whether the change is reusable or project-specific
- whether any router/catalog behavior changed

## Suggested Commit Style

Examples:
- `router: add optional task overlay selection`
- `catalog: register balanced codex adapter`
- `overlay: add reusable frontend professionalism layer`
- `meta: add role creation gate`
