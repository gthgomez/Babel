<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: X Category Clarity (v2.0)
**Category:** Governance
**Status:** Active
**Activation:** Load when an X/Twitter post, thread, or reply needs a cold reader to understand what a product is, what category it belongs to, or why a category split matters before deeper proof or technical detail.

---

## Purpose

Force first-read clarity before category positioning.

Use this skill when the message includes:
- a niche acronym or unfamiliar term
- a product/category split that a new visitor might miss
- a comparison that depends on understanding the base concept first
- a launch post that should read cleanly to someone who has never seen the account

Pairs naturally with `skill_x_marketing_manager`.
Pair with `skill_outbound_truth_redlining` or `skill_product_reality_audit` when the post makes factual claims.

---

## Workflow

### 1. Write the plain-English definition first

Reduce the product or concept to one sentence a non-expert can repeat.

If the reader cannot explain it back in plain language, the post is not ready.

### 2. Expand the acronym or category term on first use

Do not assume the reader knows the shorthand.

If the shorthand is central to the post, define it before using it as a comparison point.

### 3. Split definition, distinction, and consequence

Use this order:
1. what it is
2. how it differs from nearby categories
3. why the difference matters

Do not start with the comparison if the base concept itself is still unclear.

### 4. Keep the first sentence mobile-simple

The opening line should survive a cold scroll.

Prefer:
- short clauses
- familiar words
- one main idea

Avoid:
- layered jargon
- internal architecture first
- clever phrasing that hides the point

### 5. Use analogy only if it preserves truth

Use a familiar analogy when it helps comprehension.

Do not use an analogy that overstates enforcement, automation, or scope.

### 6. Return a cold-reader package

Always output:
- plain-English definition
- category split
- final post copy
- shorter fallback version if the audience is broad

---

## Hard Rules

1. Do not assume the reader knows the acronym.
2. Do not lead with internal implementation detail if the audience is broad.
3. Do not let the category split replace the definition.
4. Do not use a false analogy just to sound simple.
5. Do not make the first line depend on prior account context.
6. Do not claim factual behavior unless it has been verified.
7. Do not replace sequencing or reply strategy with this skill.

---

## Boundaries — Do Not Overstep
- This skill provides Babel-specific X/Twitter platform conventions. Platform policies (rate limits, API terms) must be verified against current X developer documentation.
- Social media strategy guidance is advisory — final posting decisions rest with the human operator.

## Failure Behavior of This Skill
- **X API or policy has changed:** Flag as STALE. Recommend verification against current X developer docs.
- **Engagement strategy conflicts with another skill:** Activate `coherence-linter` to detect and resolve.

## Strategic Next Move
After every substantial response, end with one strategic next-move question.

## References
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening social media patterns.
- `skill_standards_currency_audit` (`02_Skills/Governance/Standards-Currency-Audit-v2.md`) — for re-verification of X API details.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting contradictions.

---

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-20 per Phase 4 Tier 3 Migration — Block 5 (Social & Cross-Domain).
