<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Log Analysis Skill v1

## Activation

Load for tasks that require parsing log files, aggregating event counts, producing CSV/JSON summaries, or computing date-window metrics from timestamped operational records.

## Rules

1. Do not pass wildcard paths to file tools. List directories first, then read concrete files, or write a small helper program when many files must be processed.
2. For many-file log aggregation, prefer a deterministic helper program that iterates every concrete file in the input directory over manual file sampling.
3. For date-window reports, define inclusive boundaries before counting. Name the reference date explicitly.
4. Interpret "last N days including today" as exactly N calendar dates: start at `reference_date - (N - 1) days`, end at the reference date, and include both endpoints.
5. When logs encode severity as a field or token such as `[ERROR]`, count that exact field/token. Do not count prose mentions of the word inside the message text.
6. Count only the requested severities or event classes. Ignore unrelated levels such as DEBUG unless the task asks for them.
7. Preserve the exact requested output schema, row order, delimiter, header, and literal labels. Use the Exact Output Schema skill as the source of truth.

## CSV Output Checklist

- Header matches exactly.
- Required rows are present in the requested order.
- Period labels match the requested machine labels exactly, including underscores.
- Counts are serialized as plain integers.
- The file is written to the exact requested target path.

---

## Boundaries — Do Not Overstep
- This skill provides Babel-specific cognitive and evidence handling patterns. It does not replace official documentation for the underlying frameworks or data formats.
- Version-specific guidance must be verified against current stable releases before use.

## Failure Behavior of This Skill
- **Referenced pattern or schema is outdated:** Flag as STALE. Recommend verification against current standards.
- **Guidance conflicts with another skill:** Activate `coherence-linter` to detect and resolve.

## Strategic Next Move
After every substantial response, end with one strategic next-move question.

## References
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening patterns.
- `skill_standards_currency_audit` (`02_Skills/Governance/Standards-Currency-Audit-v2.md`) — for scheduled re-verification.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting contradictions.

---

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-20.
