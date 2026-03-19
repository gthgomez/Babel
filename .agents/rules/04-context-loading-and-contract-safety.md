# Babel Context Loading And Contract Safety

Read this rule before changing prompt assets, routing behavior, or control-plane tooling.

## Smallest Correct Context

- Load only the rules needed for the task.
- Use a skill only when the workflow truly repeats.
- Start from `BABEL_BIBLE.md` and `PROJECT_CONTEXT.md`, then load only the router, catalog, adapter, or tool files that own the contract.

## Contracts To Protect

- `prompt_catalog.yaml` as the canonical registry
- v9 default router and v8 compatibility fallback
- separation between Behavioral OS, Domain Architects, Skills, and model adapters
- compiler expansion from `instruction_stack` into compatibility outputs
- compiled-memory and sync tooling behavior
- repo overlays and task overlays remaining thin and scoped

## Change Classification

- `COMPATIBLE`: internal cleanup with no routing, catalog, or compatibility-output change
- `RISKY`: changes router selection, catalog behavior, compiled-memory output, or layer loading semantics
- `BREAKING`: weakens canonical registries, collapses layer boundaries, or changes compatibility contracts without migration

For `RISKY` or `BREAKING` changes, name the impacted lane, validation path, and rollback or mitigation plan.
