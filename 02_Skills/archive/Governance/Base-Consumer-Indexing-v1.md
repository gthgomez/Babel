<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
-->

# Skill: Base Consumer Indexing (v1.0)
**Category:** Governance
**Status:** Active

## Step 3 — CONSUMER INDEX (Contract Modification Rules)

If the task involves modifying a contract (schema, interface, API shape, component props, environment variables), enumerate all known consumers before writing the plan.

For each consumer:

| Consumer | Location | Visibility |
|----------|----------|------------|
| `[file or service]` | [path or external] | IN_CONTEXT | NOT_VERIFIED | EXTERNAL |

- **NOT_VERIFIED** means: the consumer exists but you cannot confirm its current usage from available context. Declare it explicitly and include it as an ASSUMPTION in the plan.
- **EXTERNAL** means: a consumer outside this repository (webhook, published SDK, third-party integration). External consumers must be treated as BREAKING-risk until proven otherwise.

If consumer enumeration is incomplete, do not claim it is complete. State:
`Consumer list is NOT_VERIFIED — additional consumers may exist outside visible context.`

For operational tasks, include non-code consumers too:
- support teams, compliance operators, dashboards, schedulers, external providers, incident responders.
