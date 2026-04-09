<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Babel Local Mode

## Purpose

In `Babel-public`, Local Mode means using the public control plane from your own machine without private repo tooling.

There are two Local Mode surfaces:

1. **Preview-first Local Mode**
2. **Advanced runtime harness**

The public-first Local Mode workflow is:

1. validate the repo
2. preview the resolved stack
3. inspect the manifest
4. only then decide whether you need the advanced runtime harness

## What Local Mode Truthfully Includes Here

- stack selection from the public catalog
- deterministic resolver preview
- read-only MCP manifest inspection
- public examples and proof artifacts

## What Is Advanced

- `babel-cli run`
- manual bridge / autonomous pipeline flows
- any path that depends on local model CLIs or credentials

Those surfaces are available, but they are not the default first-success path in the public repo.

## Recommended Public Flow

Run the validation suite:

```powershell
pwsh -File .\tools\validate-public-release.ps1
```

Preview the stack:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -PipelineMode verified `
  -Format json
```

Preview the mobile lane too:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory mobile `
  -Project example_mobile_suite `
  -Model codex `
  -Format json
```

If you want the compiled CLI commands shown in `babel --help`, build first:

```powershell
cd .\babel-cli
npm run build
node .\dist\index.js doctor
```

## What The CLI Is Good For

- `babel doctor` = environment and workspace diagnostics
- `babel run` = run a task through the Babel pipeline
- `babel plan` / `resume` = manual bridge flow
- `babel mcp` = read-only integration surface for MCP clients

The CLI is real, but it is not the easiest first contact with Babel. The resolver and validator are still the clearest public starting point.

## What Advanced Runtime Usually Requires

Expect some or all of the following before `babel run` feels smooth:

- `npm install` in `babel-cli`
- `npm run build` if you want the compiled `node .\dist\index.js ...` commands
- provider credentials or local model CLIs for the model family you choose
- explicit runtime configuration if you want autonomous execution rather than preview/manual flows

If you just want to understand Babel, you do not need any of that. Stay on the preview-first lane.

## Run Modes

`babel run` supports four modes:

- `direct` = fastest path with minimal extra gating
- `verified` = adds QA review before execution
- `manual` = produces a manual-bridge handoff instead of a normal run
- `autonomous` = most capable and most demanding runtime path

## Relationship To Other Repos

If you use Babel-public while working inside another codebase, that codebase may have its own repo-local rules or collaboration system.

That repo-local system is external to `Babel-public`.

Public rule of thumb:

- Babel chooses the stack.
- The target repo defines its own ground truth.
- Repo-local invariants win for repo-specific behavior.

## Advanced Wrapper

If you do want to try the runtime harness:

```powershell
pwsh -File .\tools\run-babel-local-cli.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -Mode manual `
  -TaskPrompt "Plan a safe backend refactor"
```

Use that path only after you understand the deterministic preview flow.
