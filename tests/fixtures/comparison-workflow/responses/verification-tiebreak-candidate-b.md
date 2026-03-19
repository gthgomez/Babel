OBJECTIVE:
Produce a reviewable pairwise comparison record for Babel Local.

KNOWN FACTS:
- Pairwise records can be stored under `tests/fixtures/` for reviewability.
- Deterministic scoring requires explicit criteria weights and score scale.

VERIFICATION METHOD:
1. Run scoring script in JSON mode and parse output.
2. Check weighted totals, decision rule, and winner ID.
3. Fail if expected values do not match.
