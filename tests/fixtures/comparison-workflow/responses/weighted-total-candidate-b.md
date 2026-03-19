OBJECTIVE:
Implement only the requested router fix with no layer drift.

KNOWN FACTS:
- `prompt_catalog.yaml` already contains the routable IDs.
- Resolver tests cover codex, claude, and gemini profiles.

ASSUMPTIONS:
- No new prompt entries are required for this patch.

MINIMAL ACTION SET:
1. Apply a bounded resolver patch.
2. Add fixture-backed regression checks.
3. Re-run deterministic tooling validation.

VERIFICATION METHOD:
- Validate command exits with code 0.
- Confirm expected fixture IDs match actual output exactly.
