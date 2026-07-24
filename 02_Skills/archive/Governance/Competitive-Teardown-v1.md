<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Competitive Teardown (v1.0)

**Category:** Governance
**Status:** Active
**Pairs with:** `domain_research`, `domain_compliance_gpc`
**Activation:** Load for competitive comparisons, wedge analysis, "where we win / where we are vulnerable" tasks, and any teardown that must stay anchored to verified product capability.

## Purpose

Competitive work goes bad when the home product is idealized and competitors are caricatured.

This skill forces a grounded baseline:
- define what the local product really does first
- compare only on verified axes
- separate `we have it` from `we market it`

## Step 1 — VERIFIED BASELINE

Write the local product baseline before discussing competitors:

| Axis | Verified Local Capability | Confidence |
|------|---------------------------|------------|
| Control point | [...] | [high / medium / low] |
| Fail-closed behavior | [...] | [...] |
| Evidence quality | [...] | [...] |
| Enterprise readiness | [...] | [...] |
| Integration burden | [...] | [...] |

No baseline, no teardown.

## Step 2 — COMPARISON AXES

Use stable axes:
- control point depth
- fail-closed scope
- evidence richness
- implementation completeness
- enterprise completeness
- integration friction

## Step 3 — VERDICT TYPES

Use:
- `WIN`
- `MIXED`
- `VULNERABLE`
- `UNVERIFIED`

`UNVERIFIED` is acceptable when competitor internals are not visible. It is better than bluffing.

## Step 4 — CLAIM DISCIPLINE

Safe:
- "On verified local code, we currently have..."
- "We have not verified competitor internals here..."
- "Our vulnerability is..."

Unsafe:
- "They can't do this"
- "We clearly beat them"
- "No competitor offers..."

unless you actually verified that externally.

## Hard Rules

1. Do not compare aspirational local features against shipped competitor features.
2. Do not treat competitor silence as technical absence.
3. Use `VULNERABLE` when the local product is weaker on enterprise completeness, integrations, or coverage.
4. A narrow win on one axis does not justify broad superiority copy.
5. If the local product lacks a verified control point, do not market it as the deepest enforcement layer.
