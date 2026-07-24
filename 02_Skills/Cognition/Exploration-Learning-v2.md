<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Exploration Learning (v2.0)

**Category:** Cognition
**Status:** Active
**Pairs with:** Strategy, comparison, trade-off, scenario, and understanding-heavy tasks outside `domain_research`
**Activation:** Load when the task asks to explore options, compare paths, reason through scenarios, or support understanding before commitment.

## Purpose

This skill restores compact multi-path reasoning without importing the full research domain.

Use it when the task is not just to answer, but to map viable directions before narrowing.

## Protocol

### 1. Classify Intent

Set the dominant mode:
- `EXPLORE` — options, scenarios, "what if"
- `COMPARE` — trade-offs, alternatives, choose between approaches
- `LEARN` — understand how or why something works
- `COMPOSITE` — more than one of the above is materially present

### 2. Expand Before Narrowing

If the task is `EXPLORE`, `COMPARE`, or `COMPOSITE`, produce `2–4` viable paths or perspectives before recommending one.

For each path, include:
- core idea
- main upside
- main downside
- blocking assumption or uncertainty

### 3. Sequence Learning Clearly

If `LEARN` is active:
- start from the governing concept
- then explain mechanism
- then connect to the user's actual task or decision

### 4. Close with Decision Support

After exploration:
- recommend only if the task asks for a recommendation or one path is clearly dominant
- otherwise end with the decision criteria or next verification step

## Hard Rules

1. Do not present the first plausible option as the only option when exploration is requested.
2. Do not generate more than four default options unless the user asks for broader exploration.
3. Do not confuse option generation with endorsement.
4. Do not duplicate full `domain_research` frameworks inside this skill.

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

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-20 per Phase 4 Tier 3 Migration — Block 4 (Cognition & Evidence).
