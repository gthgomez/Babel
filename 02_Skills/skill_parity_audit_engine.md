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
- **PASS Criteria:** Outputs satisfy the declared money representation and comparison contract. Require bit-identical integer-minor-unit output only when the source contract specifies it.

## Quality Gates
- **Gate 1:** No schema drift.
- **Gate 2:** Contract-defined parity on financial outputs.
- **Gate 3:** Zero use of `Float` types in money paths.
