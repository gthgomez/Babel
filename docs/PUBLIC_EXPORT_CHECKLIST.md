# Public Export Checklist

Use this checklist when updating `Babel-public` from `Babel-private`.

## Copy As-Is Only When Still Public-Safe

- `README.md`, `START_HERE.md`, public examples, and release notes
- `01_Behavioral_OS/` and `03_Model_Adapters/`
- generic domain architects and reusable generic skills
- runtime/compiler code that does not expose private identifiers
- validation tooling intended for the public repo

## Generalize Or Replace

- project overlays: convert private overlays into example overlays
- task overlays tied to private products: convert into example deltas or omit
- `prompt_catalog.yaml`: register only public-safe overlays, IDs, and descriptions
- orchestrator examples, paths, project IDs, and keyword examples
- tests and fixtures that still name private projects or local paths
- docs that mention private deployments, operator workflows, or repo-specific heuristics

## Remove From Public Export

- `.env*` files of any kind, including `.env.example`
- personal notes and operator context
- local machine paths
- private project names, app names, package IDs, bundle IDs, product IDs, and SKUs
- deployment URLs, internal endpoint names, and service fingerprints
- internal routing thresholds, timeout tables, and operational tuning that fingerprints private systems
- raw `runs/` artifacts and other local-only telemetry or scratch outputs

## Required Checks Before Release

1. Run `pwsh -File tools\validate-public-release.ps1`
2. Run `pwsh -File tools\resolve-local-stack.ps1 -TaskCategory backend -Project example_saas_backend -Model codex -PipelineMode verified -Format json`
3. Compare that output to `examples/manifest-previews/backend-verified.json`
4. Run `pwsh -File tools\resolve-local-stack.ps1 -TaskCategory mobile -Project example_mobile_suite -Model codex -SkillIds skill_android_pdf_processing -Format json`
5. Compare that output to `examples/manifest-previews/mobile-pdf-direct.json`
6. Manually review `README.md`, `START_HERE.md`, `examples/`, and release notes for private fingerprints
