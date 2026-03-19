OBJECTIVE: Add Phase 4 quality fixtures while preserving existing Babel contracts.

Contract: Fixture-spec contract for deterministic quality grading inputs and expected outcomes.

Consumers:
- tools/test-eval-quality-fixtures.ps1
- Local and CI verification workflows that execute the fixture grader

Breaking Changes (BCDP): COMPATIBLE
Migration Strategy: Not required because the change is additive in tests and tooling only.

Invariant Preservation:
- prompt_catalog.yaml remains unchanged.
- 01_Behavioral_OS is untouched.
- Existing local-session and compiled-memory scripts remain in their current flows.
