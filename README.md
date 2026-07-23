# Babel

[![Release](https://img.shields.io/github/v/release/gthgomez/Babel?display_name=tag&sort=semver)](https://github.com/gthgomez/Babel/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/gthgomez/Babel/typecheck.yml?branch=main&label=Public%20Release%20Gate)](https://github.com/gthgomez/Babel/actions)

**Babel is a prompt operating system for software work.**  
It chooses a small, explicit instruction stack for a task (behavioral rules, domain knowledge, skills, model adapters, and overlays), shows you exactly what it selected, and gives you local tools to validate, inspect, and run that stack.

| | |
|---|---|
| **Canonical source** | This repo — [`gthgomez/Babel`](https://github.com/gthgomez/Babel) |
| **Current release** | [**v0.1.0**](https://github.com/gthgomez/Babel/releases/tag/v0.1.0) (pre-1.0; public API still stabilizing) |
| **Primary product** | Catalog-driven stack selection + deterministic preview |
| **Also included** | Typed `babel-cli` harness, read-only MCP surface, security/release gates |

Day-to-day Babel development happens **here**. Consumer projects pin a **release tag + commit SHA**; they do not generate or overwrite this repository. See [ADR-0001](./docs/adr/ADR-0001-canonical-public-source.md) and [docs/guides/RELEASE.md](./docs/guides/RELEASE.md).

## What this repository is

A clean clone is the full public product surface:

| Surface | Status |
|---------|--------|
| Layered prompt library (`00_`–`06_`, catalog) | Canonical |
| Typed v9 router / catalog resolver | Canonical |
| Deterministic stack + manifest preview | **Primary onboarding path** |
| Public examples + golden previews | Supported |
| Security gates (scrub, content policy, secret scan) | Required on every PR |
| `babel-cli` typecheck + public validation | Supported in CI |
| Read-only MCP control-plane inspection | Supported |
| `babel run` / model-backed pipeline | Present (advanced; may need local credentials) |

**Preview and validation are the default product.**  
The task-running CLI is real and typechecked, but it is the advanced lane—not the first success path.

## Current state (v0.1.0)

As of the first public pre-1.0 release:

- **This repo is the sole canonical public source** for Babel prompts, CLI, docs, and validation tooling
- A clean clone works without private workspace knowledge or a parent monorepo
- **CI (Public Release Gate)** on every PR: `security` → `public-content-policy` → `linux-validation` (+ `windows-portability`)
- **`main` is PR-only** with branch protection; `v*` tags are protected
- Secret scanning and push protection are enabled
- Optional local pre-commit hooks exist; **CI is authoritative** (see [CONTRIBUTING.md](./CONTRIBUTING.md))
- Operator-only material, machine paths, and private dependency fingerprints are blocked by policy
- Consumers should pin when ready:

```json
{
  "babel": {
    "tag": "v0.1.0",
    "sha": "8184bbbbfa818001382fdeaf8e9d51ba8bf6003d"
  }
}
```

Pre-1.0 note: breaking changes to the v9 orchestrator contract, agent output schemas, or catalog format may still occur before `1.0.0`.

## Vision

Babel is meant to become the community prompt layer for reliable AI-assisted software work.

1. Make stack selection understandable **before** a model acts  
2. Keep prompts modular, inspectable, and testable  
3. Integrate tools through read-only control-plane surfaces first  
4. Make task execution progressively safer with evidence and verification  
5. Keep this public repo clean enough to fork, learn from, and build on  

Longer product direction: [docs/VISION.md](./docs/VISION.md).

## Choose Your Path

If you are new here, pick one lane:

- **Verify the repo works:** run `pwsh -File .\tools\validate-public-release.ps1`
- **See what Babel would choose for a task:** run `pwsh -File .\tools\resolve-local-stack.ps1 ...`
- **Inspect the control plane from another tool:** use `babel mcp` after building the CLI
- **Run a real task through Babel:** use `babel doctor` first, then `babel run ...`

## Quick Start

1. Install CLI dependencies:

```powershell
cd .\babel-cli
npm install
cd ..
```

2. Run the public validation suite:

```powershell
pwsh -File .\tools\validate-public-release.ps1
```

3. Preview a backend manifest from the public catalog:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -PipelineMode verified `
  -Format json
```

4. Compare the output to the checked-in golden preview:

- [examples/manifest-previews/backend-verified.json](./examples/manifest-previews/backend-verified.json)

5. Try the Android/mobile lane too:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory mobile `
  -Project example_mobile_suite `
  -Model codex `
  -Format json
```

- [examples/manifest-previews/mobile-direct.json](./examples/manifest-previews/mobile-direct.json)

6. If you want the compiled CLI commands, build `babel-cli`:

```powershell
cd .\babel-cli
npm run build
node .\dist\index.js doctor
cd ..
```

## What Babel Does

Babel makes the stack explicit before the model starts working:

1. pick the right behavioral rules
2. choose one domain architect
3. expand default skills and skill dependencies
4. attach the model adapter
5. attach the relevant project/task overlays
6. compile the ordered manifest preview from the catalog

## What Babel Local Means

There are two practical surfaces in this repo:

- **Preview-first Local Mode:** validate the repo, preview the manifest, compare to golden examples, inspect the MCP surface
- **Advanced runtime harness:** run tasks through the pipeline with `babel run` or `tools/run-babel-local-cli.ps1`

The first surface is what the public repo is optimized for. The second is available, but it assumes more local setup.

## Verification Surfaces

- [START_HERE.md](./START_HERE.md) — the fastest public onboarding path
- [docs/VISION.md](./docs/VISION.md) — current state, principles, and public scope
- [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md) — copy-paste CLI flows for `doctor`, `run`, `plan`, and `mcp`
- [examples/first-success.md](./examples/first-success.md) — the shortest validation walkthrough
- [examples/manifest-previews/backend-verified.json](./examples/manifest-previews/backend-verified.json) — golden backend preview
- [examples/manifest-previews/mobile-direct.json](./examples/manifest-previews/mobile-direct.json) — golden Android/mobile preview
- [docs/architecture/ARCHITECTURE.md](./docs/architecture/ARCHITECTURE.md) — public architecture and product shape
- [docs/architecture/BABEL_LOCAL_MODE.md](./docs/architecture/BABEL_LOCAL_MODE.md) — what the public runtime does and does not promise

## Useful Commands

Verify the public repo:

```powershell
pwsh -File .\tools\validate-public-release.ps1
```

Run the focused disclosure and repository-independence gates:

```powershell
pwsh -File .\tools\check-public-content-policy.ps1
pwsh -File .\tools\check-canonical-independence.ps1
```

Maintainers must additionally run the strict release validator with the
confidential supplemental policy stored outside the repository:

```powershell
pwsh -File .\tools\validate-public-release.ps1 -Strict `
  -RequireSupplementalPolicy `
  -SupplementalPolicyPath $env:BABEL_PRIVATE_SCRUB_POLICY_PATH
```

The explicit argument takes precedence over the environment variable. A
configured policy that is missing or malformed fails closed, and findings
report only category, repository path, and line number.

Preview a manifest directly from the resolver:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -PipelineMode verified `
  -Format json
```

Build the compiled CLI and run diagnostics:

```powershell
cd .\babel-cli
npm run build
node .\dist\index.js doctor
```

For the shortest CLI command guide, see [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md).

Run the read-only MCP server:

```powershell
cd .\babel-cli
npm run build
node .\dist\index.js mcp
```

Use the advanced runtime wrapper:

```powershell
pwsh -File .\tools\run-babel-local-cli.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -Mode manual `
  -TaskPrompt "Plan a safe backend refactor"
```

`babel run` modes in plain English:

- `direct` = fastest path with the fewest gates
- `verified` = adds QA review before execution
- `manual` = emits manual-bridge handoff JSON instead of normal run output
- `autonomous` = highest-risk lane; may use more tool execution and runtime setup

## Contributing Direction

Good public contributions usually improve one of these surfaces:

- clearer onboarding docs
- safer or more deterministic resolver behavior
- better public examples and golden previews
- more precise skills, domain architects, or adapters
- stronger validation, scrub, and release checks

Organization-specific workspace names, credentials, machine-specific paths, and operator-only release notes do not belong in this repo.

## Repository Structure

```
Babel/
├── START_HERE.md
├── BABEL_BIBLE.md
├── PROJECT_CONTEXT.md
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

## License

MIT. Use it, fork it, and build on it.

Full text: [LICENSE](./LICENSE)
