<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Exact Output Schema Skill v1

## Activation

Load for tasks that require a generated CSV, JSON, TSV, text report, CLI output, or data file to
match a requested schema, fixture, or literal example.

## Rules

1. Treat the requested output example as a contract, not a suggestion.
2. Copy literal headers, keys, labels, row order, casing, underscores, delimiters, and file paths exactly.
3. Do not rename machine labels to prose labels. For example, `last_7_days` must not become
   `last 7 days`, `last week`, or `Last 7 days`.
4. Do not pivot a row-oriented schema into a column-oriented schema, or the reverse, unless the task
   explicitly asks for that transformation.
5. Emit every required row or field from the example, even when a count is zero.
6. Before completion, compare the generated artifact shape against the requested schema literally:
   header/key set, row count, row order, delimiter, and label spelling.

## CSV Checklist

- Header is byte-for-byte equal to the requested header.
- Data rows follow the exact requested order.
- Each row has the exact requested column count.
- Counts and numeric values are serialized as plain decimal numbers unless another format is requested.
- No extra columns, summary rows, explanatory comments, or renamed labels are added.

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
