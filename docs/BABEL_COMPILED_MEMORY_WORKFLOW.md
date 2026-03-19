# Babel Compiled Memory Workflow

## Purpose

Define deterministic generation for Babel's tool-native memory files:
- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`

## Canonical Source Of Truth

The canonical source list is defined in:
- `tools/model-manifest-sources.json`

This config declares:
- shared source files used by every model manifest
- model-specific overlay source file per manifest
- output filename per model

Generated files are outputs only.
Do not edit generated manifests manually.

## Compiler Path

Resolver:
- `tools/resolve-control-plane.ps1`

Compiler:
- `tools/sync-model-manifests.ps1`

Regression test:
- `tools/test-sync-model-manifests.ps1`
- `tools/test-resolve-control-plane.ps1`

## Regeneration

From Babel repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\sync-model-manifests.ps1
```

To verify generated files are current without writing:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\sync-model-manifests.ps1 -Check
```

## Determinism Contract

- Re-running generation without source changes must produce byte-identical outputs.
- Generated manifests include canonical source hashes for auditability.
- Non-deterministic timestamp fields are intentionally excluded.

## Verification

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-sync-model-manifests.ps1
powershell -ExecutionPolicy Bypass -File .\tools\test-resolve-control-plane.ps1
```
