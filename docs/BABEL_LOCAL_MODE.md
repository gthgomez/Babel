<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Babel Local Mode

## Purpose

In `Babel-public`, Local Mode means using the public control plane from your own machine without private repo tooling.

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

Or run the resolver directly from the public helper:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory mobile `
  -Project example_mobile_suite `
  -Model codex `
  -Format json
```

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
