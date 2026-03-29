# Public Release Hardening Report

## What Was Inconsistent

`Babel-public` had a credibility gap between what the docs implied and what a stranger could immediately prove from a clean public repo. The main problems were:

- the public helper wrappers still reflected private/local-mode assumptions
- the public-first onboarding path was not centered on a deterministic no-credentials success case
- Android/mobile was present in the catalog/docs but not first-class in the helper flow
- the export generator could drift away from the hardened public shape

## What Was Fixed

- Reframed `Babel-public` as a runnable public-safe control-plane subset, with validation plus manifest preview as the canonical first success path.
- Added a real public resolver preview surface via `babel-cli/scripts/preview_manifest.ts`.
- Added golden proof artifacts:
  - `examples/manifest-previews/backend-verified.json`
  - `examples/manifest-previews/mobile-pdf-direct.json`
- Added regression coverage for the preview flow with `npm run test:manifest-preview`.
- Strengthened the public validation path with `tools/validate-public-release.ps1`.
- Replaced the public wrapper scripts with public-safe versions:
  - `tools/resolve-local-stack.ps1`
  - `tools/run-babel-local-cli.ps1`
- Updated major public docs so commands, runtime claims, and proof artifacts all match the public-safe reality.
- Hardened the private export generator with public templates and export-test coverage so future exports preserve these changes.

## What Remains Intentionally Private

- private project overlays and private task deltas
- private local-learning / lifecycle tooling
- operator notes and private heuristics
- private run artifacts and private repo-specific collaboration systems
- any runtime surfaces that would expose private operational details or workstation-specific assumptions

## What Babel-public Now Truthfully Is

`Babel-public` is a **runnable public-safe Babel control-plane subset**.

From this repo alone, a new user can now:

1. install `babel-cli`
2. run `pwsh -File tools\validate-public-release.ps1`
3. preview a resolved backend or Android/mobile manifest
4. compare that output to deterministic golden artifacts in `examples/manifest-previews/`
5. inspect the same resolver lane through the read-only MCP surface

The larger multi-agent pipeline harness is still present, but it is documented as advanced and credential/tooling-dependent rather than the primary public promise.

## Recommended Next Step

Add a lightweight GitHub Actions workflow in `Babel-public` that runs `tools/validate-public-release.ps1` on every push/PR so the public release face stays continuously verified.
