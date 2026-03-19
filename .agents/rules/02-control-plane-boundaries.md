# Babel Control Plane Boundaries

Read this rule before touching routers, Behavioral OS, catalog entries, or compiled-memory tooling.

## Protected Invariants

1. `OLS-v9-Orchestrator.md` remains the default typed lane.
2. `OLS-v8-Orchestrator.md` remains the compatibility fallback until explicitly retired.
3. Behavioral OS, Domain Architects, Skills, and adapters stay separated.
4. `prompt_catalog.yaml` remains the canonical registry.
5. Changes to `01_Behavioral_OS/` are global breaking changes.

## Verification

- Validate catalog and resolver behavior after routing changes.
- Re-run the narrowest relevant regression tests before closing.
- Call out any compatibility or migration impact explicitly.
