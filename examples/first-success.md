# First Verification

This is the shortest deterministic check of Babel's public resolver path.

## Before Babel

A software task usually starts with a vague prompt:

```text
Fix the backend auth issue.
```

That leaves important choices implicit:

- Which behavioral rules apply?
- Is this backend, frontend, mobile, compliance, or research work?
- Which skills should the model use?
- Which model adapter should shape the response?
- Which project or task overlay matters?

## With Babel

Babel turns that into an inspectable stack before execution.

Example:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -PipelineMode verified `
  -Format json
```

The output shows the resolved instruction stack and ordered manifest preview from `prompt_catalog.yaml`.

## What To Verify

You can compare the result to:

- `examples/manifest-previews/backend-verified.json`
- `examples/manifest-previews/mobile-direct.json`

Matching the checked-in preview verifies, for this fixture and command:

- the catalog is valid
- the resolver can select public layers
- default skills and dependencies expand deterministically
- the model-facing stack is inspectable before any model-backed run

## Next Step

After this check, choose one path:

- read `docs/VISION.md` to understand the direction
- read `docs/CLI_QUICKSTART.md` to use the CLI
- run `babel mcp` to inspect Babel from another client
- try `babel run` only after local model/provider setup is ready
