# Babel

[![Release](https://img.shields.io/github/v/release/gthgomez/Babel?display_name=tag&sort=semver)](https://github.com/gthgomez/Babel/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/gthgomez/Babel/typecheck.yml?branch=main&label=Public%20Release%20Gate)](https://github.com/gthgomez/Babel/actions)

**Babel is a coding agent for real software work.**

It plans and executes engineering tasks with a **small, explicit instruction stack**—behavioral rules, domain knowledge, skills, model adapters, and project overlays—so you can see *how* the agent will work before (and while) it acts.

Most “AI coding” tools hide the system prompt. Babel treats the agent’s operating instructions as a **catalogued, inspectable product**: modular, testable, and versioned in git.

| | |
|---|---|
| **What it is** | A coding agent + the prompt/control stack that drives it |
| **Canonical source** | This repo — [`gthgomez/Babel`](https://github.com/gthgomez/Babel) |
| **Current release** | [**v0.1.0**](https://github.com/gthgomez/Babel/releases/tag/v0.1.0) (pre-1.0) |
| **Runtime** | Typed local `babel-cli` (plan / run / doctor / MCP) |
| **Differentiator** | Explicit stack selection you can preview, validate, and improve |

Day-to-day Babel development happens **here**. Other products and workspaces pin a **release tag + commit SHA**; they do not generate or overwrite this repository. See [ADR-0001](./docs/adr/ADR-0001-canonical-public-source.md) and [docs/guides/RELEASE.md](./docs/guides/RELEASE.md).

## Why Babel (as a coding agent)

| Goal | How Babel approaches it |
|------|-------------------------|
| Ship code safely | Plan → review → execute discipline in the behavioral layers |
| Stay domain-correct | Domain architects (backend, frontend, mobile, …) instead of one generic prompt |
| Reuse real workflows | Skills for testing, governance, review, release hygiene, and more |
| Fit the model | Model adapters tune the same agent for different LLMs |
| Stay inspectable | Catalog + resolver show the exact stack for a task *before* the model runs |
| Stay local-first | CLI and gates run from a clean clone; secrets stay out of the public tree |

Babel is **not** “just a prompt dump.” It is an **agent runtime and instruction system** aimed at software engineering.

## What ships in this repo

| Surface | Role for the coding agent |
|---------|---------------------------|
| Layered prompt library (`00_`–`06_`) | The agent’s mind: router, behavior, domain, skills, adapters, overlays |
| `prompt_catalog.yaml` | Contract for what can be routed and versioned |
| Typed v9 resolver | Picks the smallest correct stack for a task category |
| `babel-cli` | Local coding-agent harness: `doctor`, `plan`, `run`, `mcp` |
| Manifest preview / golden examples | Check stack selection before you trust a run |
| Security + content policy gates | Keep the public agent surface clean and merge-safe |
| Read-only MCP | Inspect stacks/manifests from other tools |

**Honest pre-1.0 boundary:** model-backed `babel run` is real and typechecked, but it may need local provider credentials and workspace setup. You can always validate the catalog and **preview the agent’s stack** without calling a model.

## Current state (v0.1.0)

- Sole **canonical public source** for the Babel coding agent, prompt layers, CLI, and gates
- Clean clone works **without** a private monorepo or export pipeline
- **Public Release Gate** on every PR: `security` → `public-content-policy` → `linux-validation` (+ `windows-portability`)
- **`main` is PR-only**; `v*` tags protected; secret scanning + push protection on
- Optional pre-commit hooks; **CI is authoritative** ([CONTRIBUTING.md](./CONTRIBUTING.md))
- Pin when a product is ready to depend on Babel:

```json
{
  "babel": {
    "tag": "v0.1.0",
    "sha": "8184bbbbfa818001382fdeaf8e9d51ba8bf6003d"
  }
}
```

Pre-1.0: agent contracts, catalog shape, and CLI surfaces may still change before `1.0.0`.

## Choose your path

| You want to… | Start here |
|--------------|------------|
| Confirm the agent repo is healthy | `pwsh -File .\tools\validate-public-release.ps1` |
| See what stack the agent would use | `pwsh -File .\tools\resolve-local-stack.ps1 ...` |
| Run the local coding agent | Build `babel-cli` → `babel doctor` → `babel plan` / `babel run` |
| Wire another tool into Babel | `babel mcp` (read-only control plane) |

Fastest human onboarding: [START_HERE.md](./START_HERE.md) · CLI flows: [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md)

## Quick start

1. Install CLI dependencies:

```powershell
cd .\babel-cli
npm install
cd ..
```

2. Validate the public agent surface:

```powershell
pwsh -File .\tools\validate-public-release.ps1
```

3. Preview the stack the agent would load for a backend task:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -PipelineMode verified `
  -Format json
```

Compare to the golden preview:

- [examples/manifest-previews/backend-verified.json](./examples/manifest-previews/backend-verified.json)

4. Mobile/Android lane:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory mobile `
  -Project example_mobile_suite `
  -Model codex `
  -Format json
```

- [examples/manifest-previews/mobile-direct.json](./examples/manifest-previews/mobile-direct.json)

5. Build the coding-agent CLI:

```powershell
cd .\babel-cli
npm run build
node .\dist\index.js doctor
cd ..
```

With provider credentials configured locally, use `plan` / `run` for live agent sessions (see [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md)).

## How the agent builds its stack

Before the model works a task, Babel resolves an ordered stack:

1. Behavioral rules (how the agent plans, acts, and stays safe)
2. One domain architect (what kind of software work this is)
3. Skills and skill dependencies (reusable workflows)
4. Model adapter (how to talk to the chosen model well)
5. Project / task overlays (repo- or task-specific context)
6. Compiled manifest from `prompt_catalog.yaml` (what actually loads)

That is the core product idea: **a coding agent whose “system instructions” are engineered, not improvised.**

## Running the agent locally

Two complementary modes:

| Mode | Purpose |
|------|---------|
| **Inspect** | Validate catalog, preview stack, compare goldens, MCP inspect — no model required |
| **Execute** | `babel plan` / `babel run` (or `tools/run-babel-local-cli.ps1`) — model-backed coding sessions |

`babel run` modes:

- `direct` — fastest path, fewest gates  
- `verified` — adds QA review before execution  
- `manual` — handoff JSON for external/manual bridge flows  
- `autonomous` — highest-risk lane; more tool execution and setup  

```powershell
pwsh -File .\tools\run-babel-local-cli.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -Mode manual `
  -TaskPrompt "Plan a safe backend refactor"
```

## Verification & safety surfaces

```powershell
pwsh -File .\tools\validate-public-release.ps1
pwsh -File .\tools\check-public-content-policy.ps1
pwsh -File .\tools\check-canonical-independence.ps1
```

Maintainers may run the strict release validator with a confidential supplemental policy stored **outside** this repo:

```powershell
pwsh -File .\tools\validate-public-release.ps1 -Strict `
  -RequireSupplementalPolicy `
  -SupplementalPolicyPath $env:BABEL_PRIVATE_SCRUB_POLICY_PATH
```

Read-only MCP after build:

```powershell
cd .\babel-cli
npm run build
node .\dist\index.js mcp
```

## Docs map

- [START_HERE.md](./START_HERE.md) — first success path  
- [docs/VISION.md](./docs/VISION.md) — product direction  
- [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md) — `doctor` / `plan` / `run` / `mcp`  
- [examples/first-success.md](./examples/first-success.md) — shortest validation walkthrough  
- [docs/architecture/ARCHITECTURE.md](./docs/architecture/ARCHITECTURE.md) — system shape  
- [docs/architecture/BABEL_LOCAL_MODE.md](./docs/architecture/BABEL_LOCAL_MODE.md) — what local runtime promises  
- [BABEL_BIBLE.md](./BABEL_BIBLE.md) — model/integration invocation contract  
- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to contribute  

## Contributing

Improvements that help most:

- better agent behavior (skills, domain architects, adapters)
- clearer stack selection and diagnostics
- stronger plan/run UX and `doctor` output
- examples that show real coding tasks end-to-end
- validation, scrub, and release safety

Keep out: private product names as dependencies, credentials, machine paths, and operator-only notes.

## Repository structure

```
Babel/
├── START_HERE.md          # human first success
├── BABEL_BIBLE.md         # agent/integration entry
├── PROJECT_CONTEXT.md
├── prompt_catalog.yaml    # routable agent stack contract
├── 00_System_Router/      # how tasks route
├── 01_Behavioral_OS/      # how the agent behaves
├── 02_Domain_Architects/  # domain expertise
├── 02_Skills/             # reusable workflows
├── 03_Model_Adapters/     # model-specific tuning
├── 04_Meta_Tools/
├── 05_Project_Overlays/
├── 06_Task_Overlays/
├── babel-cli/             # coding agent runtime
├── examples/
├── docs/
└── tools/                 # validate, preview, release gates
```

## License

MIT. Use it, fork it, and build on it.

Full text: [LICENSE](./LICENSE)
