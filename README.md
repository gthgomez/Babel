# Babel

[![Release](https://img.shields.io/github/v/release/gthgomez/Babel?display_name=tag&sort=semver)](https://github.com/gthgomez/Babel/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/gthgomez/Babel/typecheck.yml?branch=main&label=Public%20Release%20Gate)](https://github.com/gthgomez/Babel/actions)

**Open-source coding agent for real software work.**

Babel plans, reviews, and implements engineering tasks in your local workspace.
For each task it loads a **small, explicit instruction stack**—behavioral rules, domain expertise, skills, model adapters, and project overlays—so you can see *how* the agent will work before it edits a line of code.

| | |
|---|---|
| **Product** | Local coding agent — TUI/REPL + chat / plan / deep |
| **Primary UI** | Interactive terminal session (`babel`) |
| **Release** | [**v0.1.0**](https://github.com/gthgomez/Babel/releases/tag/v0.1.0) · pre-1.0 |
| **Source of truth** | This repo — [`gthgomez/Babel`](https://github.com/gthgomez/Babel) |
| **Edge** | Inspectable stacks, domain routing, plan → review → execute |

This is the **canonical public source**. Day-to-day Babel development happens here.
Pin consumers with a **release tag + commit SHA**. See [ADR-0001](./docs/adr/ADR-0001-canonical-public-source.md) and [docs/guides/RELEASE.md](./docs/guides/RELEASE.md).

## What Babel does

| You need to… | Babel |
|--------------|--------|
| Ship a feature or fix | Plan the work, then run an implementation session |
| Stay safe on risky changes | Prefer **plan** or **deep** when you want stronger gates before or during execution |
| Work across domains | Route backend, frontend, mobile, and more to the right expertise—not one generic prompt |
| Reuse hard-won workflows | Skills for testing, review, governance, release hygiene, and more |
| Trust the agent’s “brain” | Preview the exact stack from the catalog before the model runs |
| Integrate other tools | Read-only MCP for stack and manifest inspection |

Most coding agents hide the system prompt. Babel makes the agent’s operating instructions **modular, versioned, and testable**—engineered software, not an improvised blob.

## Quick start

```powershell
cd .\babel-cli
npm install
npm run build
node .\dist\index.js doctor
```

Validate the public surface (no model required):

```powershell
cd ..
pwsh -File .\tools\validate-public-release.ps1
```

See the stack the agent would load for a backend task:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -PipelineMode chat `
  -Format json
```

Golden preview: [examples/manifest-previews/backend-verified.json](./examples/manifest-previews/backend-verified.json)

Mobile lane:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory mobile `
  -Project example_mobile_suite `
  -Model codex `
  -Format json
```

Golden: [examples/manifest-previews/mobile-direct.json](./examples/manifest-previews/mobile-direct.json)

With local provider credentials configured:

```powershell
cd .\babel-cli
node .\dist\index.js                 # interactive TUI (chat)
node .\dist\index.js plan "..."      # plan mode
node .\dist\index.js deep "..."      # governed deep path
```

Full onboarding: [START_HERE.md](./START_HERE.md) · CLI reference: [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md)

## How the agent works

Before the model acts, Babel resolves an ordered stack from `prompt_catalog.yaml`:

1. **Behavioral rules** — how the agent plans, acts, verifies, and stays safe  
2. **Domain architect** — backend, frontend, mobile, … for this kind of work  
3. **Skills** — reusable workflows the task needs  
4. **Model adapter** — tune the same agent for the model you chose  
5. **Overlays** — project- or task-specific context  
6. **Manifest** — the exact load order you can preview and test  

That is the product idea: **a coding agent whose instructions are engineered, not improvised.**

### Product modes

| Mode | When to use |
|------|-------------|
| `chat` | Default conversational agent (TUI and one-shot tasks) |
| `chat-headless` | Same engine for scripts / CI |
| `plan` | Plan first, then apply with approval |
| `deep` | Full governed pipeline for higher-risk work |

Legacy aliases (`verified`→`deep`, `manual`→`plan`, `direct`→`chat`) still work with deprecation warnings.

### Inspect vs execute

| Mode | Purpose |
|------|---------|
| **Inspect** | Validate catalog, preview stack, compare goldens, MCP — no model required |
| **Execute** | `babel` (TUI), `babel plan`, `babel deep` — model-backed sessions |

**Pre-1.0 honesty:** model-backed runs are real and typechecked, but need local credentials and workspace setup. You can still validate and preview stacks from a clean clone with no API keys.

## What’s in the repo

| Path | Role |
|------|------|
| `00_`–`06_` prompt layers | Router, behavior, domains, skills, adapters, overlays |
| `prompt_catalog.yaml` | Routable stack contract |
| `babel-cli/` | Coding agent runtime (TUI + chat / plan / deep) |
| `examples/` | Golden stack previews and first-success walkthroughs |
| `tools/` | Validate, scrub, content policy, release gates |
| `docs/` | Architecture, vision, CLI guides |

```
Babel/
├── START_HERE.md
├── BABEL_BIBLE.md         # agent / integration entry
├── prompt_catalog.yaml
├── 00_System_Router/
├── 01_Behavioral_OS/
├── 02_Domain_Architects/
├── 02_Skills/
├── 03_Model_Adapters/
├── 04_Meta_Tools/
├── 05_Project_Overlays/
├── 06_Task_Overlays/
├── babel-cli/
├── examples/
├── docs/
└── tools/
```

## Status (v0.1.0)

- Canonical open-source coding agent surface — clone, validate, run locally  
- **Public Release Gate** on every PR: `security` → `public-content-policy` → `linux-validation` (+ `windows-portability`)  
- `main` is PR-only; `v*` tags protected; secret scanning + push protection on  
- Optional pre-commit hooks; **CI is authoritative** ([CONTRIBUTING.md](./CONTRIBUTING.md))  

Pin when ready:

```json
{
  "babel": {
    "tag": "v0.1.0",
    "sha": "8184bbbbfa818001382fdeaf8e9d51ba8bf6003d"
  }
}
```

Agent contracts and CLI surfaces may still change before `1.0.0`.

## Verification

```powershell
pwsh -File .\tools\validate-public-release.ps1
pwsh -File .\tools\check-public-content-policy.ps1
pwsh -File .\tools\check-canonical-independence.ps1
```

Maintainers may use a confidential supplemental policy stored **outside** this repo:

```powershell
pwsh -File .\tools\validate-public-release.ps1 -Strict `
  -RequireSupplementalPolicy `
  -SupplementalPolicyPath $env:BABEL_PRIVATE_SCRUB_POLICY_PATH
```

MCP (read-only):

```powershell
cd .\babel-cli
npm run build
node .\dist\index.js mcp
```

## Docs

- [START_HERE.md](./START_HERE.md) — first success  
- [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md) — TUI, chat / plan / deep, doctor, MCP  
- [docs/VISION.md](./docs/VISION.md) — product direction  
- [docs/architecture/ARCHITECTURE.md](./docs/architecture/ARCHITECTURE.md) — system shape  
- [BABEL_BIBLE.md](./BABEL_BIBLE.md) — invocation contract for models and wrappers  
- [CONTRIBUTING.md](./CONTRIBUTING.md)  

## Contributing

Highest-value work:

- stronger agent behavior (skills, domains, adapters)  
- clearer plan/run UX and diagnostics  
- end-to-end coding task examples  
- tighter stack selection and release safety  

Keep out: private dependency fingerprints, credentials, machine paths, operator-only notes.

## License

MIT. Use it, fork it, and build on it.

Full text: [LICENSE](./LICENSE)
