OBJECTIVE: Deliver Phase 4 quality fixtures and grading without entering Phase 5.

KNOWN FACTS:
- Phase 4 requires fixture coverage for planning quality, contract preservation, and verification quality.
- Fixtures should remain under tests/fixtures for reviewability and deterministic runs.

ASSUMPTIONS:
- No prompt catalog contract changes are required for Phase 4.
- Existing compiled-memory and local-session workflows remain in place.

RISKS:
- Scope creep into comparison workflows that belong to Phase 5.
- Weak grading criteria that are not directly observable in fixture outputs.

MINIMAL ACTION SET:
1. Add one bounded fixture set per required quality dimension.
2. Add one deterministic script that grades fixtures using explicit checks.
3. Run required regressions plus the new phase-specific fixture check.

VERIFICATION METHOD:
- Run required regression scripts and confirm each exits with exit code 0.
- Run the phase fixture grader and confirm no expectation mismatches.
- Confirm no changes were made under 01_Behavioral_OS.
