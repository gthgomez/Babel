# Babel Execution And Verification

Read this rule for all non-trivial work.

## Plan Vs Act

- `LOW` risk: doc-only edits, isolated copy cleanup, narrow fixture or test updates
- `MEDIUM` risk: prompt-catalog edits, adapter changes, tooling updates with a clear ownership boundary
- `HIGH` risk: orchestrator behavior, compiler or pipeline logic, Behavioral OS changes, compatibility outputs, or shared manifest tooling

Act directly only when the change is small and the contract surface is clear.
For medium or high-risk work, name the affected contract before editing.

## Verification Expectations

- Never call control-plane work complete without evidence.
- Prefer this order of evidence:
  1. direct file inspection
  2. targeted validation scripts
  3. typecheck or build output
  4. inferred behavior, clearly labeled

## Required Checks

- Router, compiler, or schema changes: run the relevant `babel-cli` typecheck or build path.
- Catalog or routing changes: run catalog or resolver validation as relevant.
- Compiled-memory tooling changes: verify the manifest-sync or control-plane test path before claiming success.
