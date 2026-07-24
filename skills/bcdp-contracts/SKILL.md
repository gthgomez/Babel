---
name: bcdp-contracts
description: Review or implement changes to shared contracts such as API shapes, schemas, exported types, component props, environment variables, event shapes, CLI output, database columns, and file formats; classify compatible, risky, and breaking changes.
---

## Prompt bridge

- **Babel catalog id:** `skill_bcdp_contracts`
- **Prompt-layer owner:** `02_Skills/Governance/BCDP-Contracts-v1.md`
- Use the prompt skill for Babel stack assembly; use this package for structured contracts, examples, and validation fixtures.

# Breaking Change Detection Protocol

Use this skill whenever a task changes an API shape, schema, exported type, component prop,
environment variable, event shape, CLI output contract, database column, or file format
that other code may consume.

## Workflow

1. Identify all known consumers before editing.
2. Classify the change as `COMPATIBLE`, `RISKY`, or `BREAKING`.
3. State the migration impact.
4. Update all in-repo consumers that can be changed atomically.
5. Add compatibility bridges when external or non-atomic consumers exist.
6. Verify the changed contract and its consumers.

## Classification

- `COMPATIBLE`: additive and existing consumers continue to work.
- `RISKY`: consumers may break depending on assumptions.
- `BREAKING`: existing consumers will break without coordinated changes.

Default to the higher-risk label when uncertain.

## Required Output

State the contract changed, classification, known consumers, migration requirement,
verification performed, and rollback path.
