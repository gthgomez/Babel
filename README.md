# Babel

**Babel is a prompt operating system for software work: it chooses a small, explicit instruction stack for a task, shows you exactly what it selected, and gives you local tools to validate, inspect, and run that stack.**

This public repo includes:

- the layered prompt library
- the typed `v9` router contract
- the catalog-driven resolver/compiler
- a read-only MCP control-plane surface
- public examples, golden previews, regression tests, and security/release gates

It also includes the larger CLI/runtime harness. That surface is real and typechecked in public CI, but model-backed execution can require local tooling, credentials, and workspace-specific policy. The canonical first success path remains deterministic validation and preview.

## Public Identity

`Babel-public` should be understood as a **runnable, public-safe Babel release**.

What is fully supported from this repo alone:

- catalog validation
- deterministic stack selection preview
- deterministic manifest preview from `prompt_catalog.yaml`
- read-only MCP manifest/stack inspection
- CLI typechecking and public release validation
- secret scanning and public scrub gates
- regression tests proving the public surfaces behave predictably

What is present but not the primary onboarding path:

- `babel-cli run`
- manual bridge / pipeline harness commands
- model-execution flows that depend on local model setup or credentials

## Current State

Babel-public is now generated from a hardened private-to-public export lane. The public repository is intended to be useful to a new community user without private workspace knowledge:

- public templates generate community-facing docs, issue templates, and CI
- `scratch/`, private repo fingerprints, and private-only operator notes are excluded
- `package-lock.json` is retained for reproducible install, with local-path/private-dependency checks
- public CI runs typecheck and the required secret scan
- release publishing goes through a release branch and PR, not direct pushes to `main`

## Vision

Babel is meant to become the community prompt layer for reliable AI-assisted software work.

The direction is:

1. make stack selection understandable before a model acts
2. keep prompts modular, inspectable, and testable
3. let tools integrate through read-only control-plane surfaces first
4. make task execution progressively safer with evidence, verification, and repo-local rules
5. keep the public repo clean enough that anyone can fork it, learn from it, and build on it

For the longer product direction, see [docs/VISION.md](./docs/VISION.md).

## Choose Your Path

If you are new here, pick one lane:

- **Verify the repo works:** run `pwsh -File .\tools\validate-public-release.ps1`
- **See what Babel would choose for a task:** run `pwsh -File .\tools\resolve-local-stack.ps1 ...`
- **Inspect the control plane from another tool:** use `babel mcp` after building the CLI
- **Run a real task through Babel:** use `babel doctor` first, then `babel run ...`

Public rule of thumb:

- preview and validation are the default product
- the task-running CLI is real, but it is the advanced lane
- MCP is an integration surface, not the everyday starting point

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

## Proof Surfaces

- [START_HERE.md](./START_HERE.md) — the fastest public onboarding path
- [docs/VISION.md](./docs/VISION.md) — current state, principles, and roadmap direction
- [docs/CLI_QUICKSTART.md](./docs/CLI_QUICKSTART.md) — copy-paste CLI flows for `doctor`, `run`, `plan`, and `mcp`
- [examples/first-success.md](./examples/first-success.md) — the shortest before/after explanation
- [examples/manifest-previews/backend-verified.json](./examples/manifest-previews/backend-verified.json) — golden backend preview
- [examples/manifest-previews/mobile-direct.json](./examples/manifest-previews/mobile-direct.json) — golden Android/mobile preview
- [docs/architecture/ARCHITECTURE.md](./docs/architecture/ARCHITECTURE.md) — public architecture and product shape
- [docs/architecture/BABEL_LOCAL_MODE.md](./docs/architecture/BABEL_LOCAL_MODE.md) — what the public runtime does and does not promise

## Useful Commands

Verify the public repo:

```powershell
pwsh -File .\tools\validate-public-release.ps1
```

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

Private workspace names, credentials, local paths, and operator-only release notes do not belong in this repo.

## Repository Structure

```
Babel-public/
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
