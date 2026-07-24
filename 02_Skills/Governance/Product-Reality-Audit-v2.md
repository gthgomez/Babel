<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Product Reality Audit (v2.0)

**Category:** Governance
**Status:** Active
**Pairs with:** `domain_research`, `domain_compliance_gpc`, `domain_swe_backend`, `domain_swe_frontend`
**Activation:** Load when a task asks whether product, marketing, legal, docs, or sales claims are actually supported by the current implementation.

## Purpose

This is not a summary skill. It is a truth-extraction skill.

Use it when the job is:
- claims vs code
- positioning vs implementation
- docs vs schema
- pricing vs entitlements
- narrative vs product reality

## Verification Surfaces

Before classifying any claim, map it to one or more implementation surfaces:

| Surface | Typical Evidence |
|---------|------------------|
| Runtime control point | middleware, proxy, edge worker, request hook, SDK interception |
| Persistence | schema, inserts, migrations, exports |
| Customer-visible behavior | API contract, dashboard UI, docs examples |
| Entitlements | tier limits, billing gates, plan config |
| Enterprise readiness | auth flows, export routes, SSO, retention jobs |

If no implementation surface exists, the claim is not TRUE.

## Status Contract

Use only:
- `TRUE` — fully implemented and directly evidenced
- `PARTIAL` — concept exists but scope, completeness, or wording is overstated
- `FALSE` — not implemented, contradicted, or currently unsupported

Default to `PARTIAL` when a concept exists but the wording outruns the code.

## Runtime Boundary Check

For any enforcement or interception claim, answer these exactly:

1. Where is the control point?
2. Does it sit in the request path of governed traffic?
3. Can it block, mutate, or deny downstream flow?
4. Is that behavior automatic or only advisory?

If the product only returns a policy payload or logs a signal, do not call it deep runtime enforcement.

## Evidence Depth Check

For any audit / proof / record claim, verify:
- persisted fields
- failure-path coverage
- mutability / tamper controls
- retention enforcement
- exportability

Demo JSON, UI mock data, and legal prose do not upgrade schema reality.

## Packaging Check

For any pricing or enterprise claim, verify:
- public copy
- backend limits
- route existence
- auth/provider existence
- retention or export jobs

Marketing copy loses to implementation.

## Recommended Output Shape

1. Claim table
2. Major mismatches
3. Risk if used in marketing or sales
4. Safe wording

## Hard Rules

1. Absence of evidence is not TRUE.
2. A docs page is not implementation evidence for runtime behavior.
3. A UI component showing synthetic payloads is not proof that those fields exist.
4. "Fail-closed" must be scoped to the path that actually fails closed.
5. "Every request" requires system-wide coverage, not one endpoint.

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
