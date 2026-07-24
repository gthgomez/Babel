<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Base Consumer Indexing (v2.0)
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
