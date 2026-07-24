<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# skill_parity_audit_engine

## Context
This skill provides the technical procedures for executing a `parity-audit` between a Source and Target project.

## Procedures

### 1. Schema Comparison
- Extract the SQLite schema from the Source project (`schema.sql`).
- Extract the Room entities from the Target project (Kotlin `@Entity` classes).
- Verify:
    - Table names match.
    - Column names match.
    - Primary keys and Foreign keys are identical.
    - `Integer` types are used for all monetary columns.

### 2. Logic Tracing
- Identify core "Critical Logic Paths" (e.g., `calculateSafeSpend`).
- Map the execution flow of the Source logic.
- Compare with the Target implementation.
- Flag any use of `Floating Point` math.

### 3. Data Verification
- Generate a `test_vector.json` containing:
    - Initial balances.
    - A set of recurring transactions.
    - A set of one-off transactions.
- Run the Source engine with this vector and capture the output.
- Run the Target engine with this vector and capture the output.
- **PASS Criteria:** Bit-identical output for all financial results.

## Quality Gates
- **Gate 1:** No schema drift.
- **Gate 2:** Bit-parity on financial outputs.
- **Gate 3:** Zero use of `Float` types in money paths.

---

## Boundaries — Do Not Overstep
- This skill provides Babel-specific governance and release conventions. It does not replace official platform documentation or security best-practice guides.
- Version-specific guidance must be verified against current stable releases before use in production plans.

## Failure Behavior of This Skill
- **Referenced policy or process is outdated:** Flag as STALE. Recommend verification against current Babel governance documentation.
- **Guidance conflicts with another governance skill:** Activate `coherence-linter` to detect and resolve.
- **Release/security gate fails:** Halt the release. Do not proceed with a failing gate.

## Strategic Next Move
After every substantial response, end with one strategic next-move question focused on the highest-leverage validation step.

## References
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening governance patterns.
- `skill_standards_currency_audit` (`02_Skills/Governance/Standards-Currency-Audit-v2.md`) — for scheduled re-verification.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting contradictions.

---

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-20 per Phase 4 Tier 3 Migration — Block 2 (Governance & Release).
