---
name: evidence-gathering
description: Gather file-backed evidence before planning or editing when tasks depend on current files, schemas, APIs, runtime surfaces, logs, issue state, or consumers; use to avoid guessed code and produce evidence receipts.
---

## Prompt bridge

- **Babel catalog id:** `skill_evidence_gathering`
- **Prompt-layer owner:** `02_Skills/Governance/Evidence-Gathering-v1.md`
- Use the prompt skill for Babel stack assembly; use this package for structured contracts, examples, and validation fixtures.

# Evidence Gathering

Use this skill before planning or editing when the task depends on current file
contents, schemas, APIs, runtime surfaces, logs, external issue state, or consumers.
It prevents plans based on guessed code.

## Workflow

1. List every file needed to understand or edit the task.
2. Read those files directly when filesystem access exists.
3. List every schema, exported type, API contract, table, or runtime surface involved.
4. Read those contracts before classifying or changing them.
5. If a contract changes, identify known consumers and mark visibility.
6. State what is observed, inferred, or unknown before implementation.

## Evidence Receipt

Before planning a non-trivial change, produce a compact receipt:

```text
Files confirmed in context: [n]
Schemas/contracts confirmed: [n]
Execution surfaces confirmed: [n]
Consumers identified: [n]
Status: evidence complete | evidence incomplete
```

## Halt Rule

If a required file or contract is inaccessible, stop and ask for it. Do not infer its shape.

## Verification

The final answer should reference commands actually run and any evidence that could not be gathered.
