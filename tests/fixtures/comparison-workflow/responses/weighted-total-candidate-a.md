OBJECTIVE:
Patch the resolver and tests while preserving existing stack-selection behavior.

KNOWN FACTS:
- The resolver is deterministic in current tests.
- Existing scripts validate known task categories.

MINIMAL ACTION SET:
1. Update resolver defaults.
2. Update regression fixtures.
3. Run validation scripts.

VERIFICATION METHOD:
- Require exit code 0 for the resolver test script.
