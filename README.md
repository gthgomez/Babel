# Babel

**Babel-public lets you validate the public catalog and preview the exact governed instruction stack Babel would load for a real task before any full execution begins.**

It is a runnable public-safe subset of Babel focused on making instruction-stack selection inspectable, deterministic, and repeatable.

This public repo includes:

- the layered prompt library
- the typed `v9` router contract as the default lane, with `v8` preserved as a legacy fallback
- the catalog-driven resolver/compiler
- a read-only MCP control-plane surface
- public examples, golden previews, and regression tests

It also includes the larger multi-agent runtime harness, but that is **advanced** and usually requires local model tooling or credentials. The canonical public success path is the deterministic preview flow, not a full end-to-end autonomous run.

## Public Identity

`Babel-public` should be understood as a **runnable public-safe Babel control-plane subset**.

What is fully supported from this repo alone:

- catalog validation
- deterministic stack selection preview
- deterministic manifest preview from `prompt_catalog.yaml`
- read-only MCP manifest/stack inspection
- regression tests proving those surfaces behave predictably

What is present but not the primary onboarding path:

- `babel-cli run`
- manual bridge / pipeline harness commands
- model-execution flows that depend on local model setup or credentials

## Quick Start

In the first two minutes, you can install the CLI, validate the public repo, and preview a real manifest resolved from `prompt_catalog.yaml`.

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
  -SkillIds skill_android_pdf_processing `
  -Format json
```

- [examples/manifest-previews/mobile-pdf-direct.json](./examples/manifest-previews/mobile-pdf-direct.json)

## What Babel Does

Babel makes the stack explicit before the model starts working:

1. pick the right behavioral rules
2. choose one domain architect
3. expand default skills and skill dependencies
4. attach the model adapter
5. attach the relevant project/task overlays
6. compile the ordered manifest preview from the catalog

## Proof Surfaces

- [START_HERE.md](./START_HERE.md) — the fastest public onboarding path
- [examples/first-success.md](./examples/first-success.md) — the shortest before/after explanation
- [examples/manifest-previews/backend-verified.json](./examples/manifest-previews/backend-verified.json) — golden backend preview
- [examples/manifest-previews/mobile-pdf-direct.json](./examples/manifest-previews/mobile-pdf-direct.json) — golden Android/mobile preview
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — public architecture and product shape
- [docs/BABEL_LOCAL_MODE.md](./docs/BABEL_LOCAL_MODE.md) — what the public runtime does and does not promise

## Useful Commands

Preview a manifest directly from the resolver:

```powershell
cd .\babel-cli
npm run preview:manifest -- --task-category backend --project example_saas_backend --model codex --pipeline-mode verified
```

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
