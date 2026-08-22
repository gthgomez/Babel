<!--
Babel — Coding Agent
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Contributing

## Scope

Babel is a **local coding-agent harness** with an inspectable Prompt OS and
governed execution. Treat runtime, prompt, verification, documentation, and UX
changes as product changes — not as a notes folder.

High-value surfaces:

- TUI / Chat runtime
- Plan and Deep
- providers and tool execution
- authority / policy
- Prompt OS / catalog / routing
- verification, recovery, and evidence
- benchmarks / evals
- docs and integrations

This repository is Babel's canonical public source. Contributions merged here
change the authoritative product; no external repository regenerates this source.
Consumer-specific overlays and operational policy belong in the consumer
repository or another documented external configuration location.

## License

Contributions are submitted under the **Apache License 2.0**. See [LICENSE](./LICENSE).

Historical tagged releases that shipped under MIT remain MIT for those snapshots.
This tree is Apache-2.0 going forward.

## AI-assisted contributions

AI-assisted contributions are allowed.

An AI tool or model listed in commit metadata or a `Co-authored-by` trailer is
**not** treated by Babel documentation as a human copyright contributor merely
because of that attribution.

The person submitting a change is responsible for reviewing it and having the
rights necessary to submit it under Apache-2.0.

This is repository policy, not legal advice. Do not rewrite historical
`Co-authored-by` trailers.

## Before You Change Babel

Read:
1. [INTEGRATION.md](./INTEGRATION.md)
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
pwsh -File .\tools\check-public-content-policy.ps1
pwsh -File .\tools\check-canonical-independence.ps1
pwsh -File .\tools\check-public-identity.ps1
```

The content-policy check rejects disclosure-prone wording, machine-specific
paths, unsupported absolute claims, duplicate active documents, and broken
relative Markdown links. The canonical-independence check verifies that a clean
clone does not require a parent workspace, sibling repository, or retired
publication artifacts. The identity check keeps front-door docs from reasserting
obsolete product language.

Maintainer pre-merge checklist:

- [ ] Keep the confidential denylist outside this repository and its Git history.
- [ ] Set `BABEL_PRIVATE_SCRUB_POLICY_PATH`, or pass the same external file with
  `-SupplementalPolicyPath`.
- [ ] Run `pwsh -File .\tools\validate-public-release.ps1 -Strict
  -RequireSupplementalPolicy
  -SupplementalPolicyPath $env:BABEL_PRIVATE_SCRUB_POLICY_PATH` and require a
  clean result before merging.

If you touched routing, compiler, or load-order logic, also inspect:
- [OLS-v9-Orchestrator.md](./00_System_Router/OLS-v9-Orchestrator.md)
- [prompt_catalog.yaml](./prompt_catalog.yaml)

Router state:
`OLS-v9-Orchestrator.md is the default typed runtime lane in babel-cli; archived pre-v9 router files are historical only.`

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

This section is the authoritative prompt/runtime co-evolution rule and trigger
list for contributors. If a change introduces another model-facing contract
surface, extend this checklist in the same PR.

## Pre-Commit Hooks (Optional)

Fast local feedback before you push. CI is the authoritative gate — hooks are
never mandatory, and you can always `git commit --no-verify` to bypass them.

**What the hook catches:**

- `.env` files (except `.env.example`)
- Secrets and API keys detected by gitleaks (if installed)
- Machine-specific paths (Windows drive-letter user paths, Unix home directories)
- Forbidden dependency fingerprints in lockfiles (e.g. private `file:` references)

**Setup (one command):**

```powershell
pwsh tools/install-hooks.ps1
```

This sets `core.hooksPath` to `.githooks/` for this repository. Remove with:

```powershell
git config --unset core.hooksPath
```

**Testing the hook:**

```powershell
# Should block: staged .env file
echo "SECRET=abc" > .env && git add .env && git commit -m "test"
# Reset after test: git reset HEAD .env && rm .env

# Should pass: staged .env.example
echo "PORT=3000" > .env.example && git add .env.example && git commit -m "test"
```

The **same classes of leak will fail CI**. The hook just tells you faster.

## Pull Request Expectations

A good Babel PR should explain:
- what surface changed (TUI, chat, plan/deep, provider, catalog, docs, …)
- why the change belongs in that layer
- whether the change is reusable or project-specific
- whether any router/catalog behavior changed
- whether any `babel-cli/src/` changes require a corresponding prompt file update (co-evolution check)
- whether content-policy, identity, and canonical-independence checks pass

## Suggested Commit Style

Examples:
- `fix(chat): keep tool identity stable across parallel completion`
- `feat(tui): improve /diff review restore`
- `docs: teach Chat before stack preview`
- `catalog: register balanced codex adapter`
- `test(cli): cover undo checkpoint restore`
