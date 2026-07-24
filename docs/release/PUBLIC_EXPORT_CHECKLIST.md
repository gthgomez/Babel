# Public Content Guidelines

<!--
status: ACTIVE
last_verified: 2026-07-24
-->
Guidelines for what content belongs in this public canonical repository.

## Safe to Include As-Is

- `README.md`, `START_HERE.md`, public examples, and release notes
- `01_Behavioral_OS/` and `03_Model_Adapters/`
- generic domain architects and reusable generic skills
- runtime/compiler code that does not expose environment-specific identifiers
- validation tooling intended for the public repo

## Needs Generalization Before Inclusion

- project overlays: strip environment-specific details; use example overlays
- task overlays tied to specific products: convert into example deltas or omit
- `prompt_catalog.yaml`: register only generally useful overlays, IDs, and descriptions
- orchestrator examples, paths, project IDs, and keyword examples
- tests and fixtures that name specific environments or local paths
- docs that mention deployment-specific details, operator workflows, or repo-specific heuristics

## Do Not Include

- credential/secret files of any kind, including example templates
- personal notes and operator context
- local machine paths
- private project names, app names, package IDs, bundle IDs, product IDs, and SKUs
- deployment URLs, internal endpoint names, and service fingerprints
- internal routing thresholds, timeout tables, and operational tuning that fingerprints specific systems
- raw `runs/` artifacts and other local-only telemetry or scratch outputs

## Review Checklist

1. Manually review `README.md`, `START_HERE.md`, `examples/`, and release notes for environment-specific fingerprints.
2. Verify that examples use placeholder values (`<YOUR_PROJECT_ROOT>`, `https://example.com/...`, `com.example.app`) rather than real identifiers.
3. Confirm no local filesystem paths, deployment URLs, or credentials are present.
