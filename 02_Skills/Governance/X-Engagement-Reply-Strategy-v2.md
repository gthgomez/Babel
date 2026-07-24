<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: X Engagement Reply Strategy (v2.0)
**Category:** Governance
**Status:** Active
**Activation:** Load when the task is to decide whether X replies should optimize for lightweight engagement or for supportive technical substance, especially when choosing between quick engagement replies, substantive help replies, reply-farming risk, or comment-chain credibility.

---

## Purpose

Use this skill to choose the intent of a reply, not just the wording.

Some replies are there to keep the conversation warm.
Some replies are there to add real technical value.
Some replies are there to correct, clarify, or extend a thread.

This skill separates those modes so the account does not drift into spammy engagement bait or into over-serious replies when a lighter touch would work better.

Pairs naturally with `skill_x_thread_reply_strategy` and `skill_x_marketing_manager`.

---

## Workflow

### 1. Classify the reply intent

Choose one:
- engagement
- technical support
- correction
- clarification
- follow-up
- amplification

If the intent is mixed, name the primary intent first.

### 2. Pick the reply mode

Use an engagement reply when the goal is to:
- acknowledge a good point
- keep a conversation alive
- sound human and light
- invite a response without baiting

Use a supportive technical reply when the goal is to:
- add a useful detail
- answer a question
- correct a misunderstanding
- provide evidence, examples, or a fix

If the audience came for proof, favor technical support.
If the audience came for vibe and momentum, favor engagement.

### 3. Set the reply shape

Engagement replies should be:
- short
- warm
- low-friction
- non-promotional

Technical replies should be:
- specific
- grounded
- useful on their own
- free of filler

### 4. Guard against reply farming

Do not:
- post generic praise just to be visible
- repeat the same sentiment across many threads
- ask shallow questions that do not move the conversation forward
- inflate engagement at the cost of trust
- turn every comment into a promo opportunity

### 5. Return the reply set

Always output:
- reply intent
- reply mode
- final copy
- whether it should be public, quoted, or skipped

---

## Hard Rules

1. Do not confuse visibility with value.
2. Do not use engagement replies as spam.
3. Do not make a technical reply fluffy just to seem friendlier.
4. Do not answer with generic praise when the user needs substance.
5. Do not overcorrect a light conversation with a lecture.
6. Do not post repeatedly in a thread unless each reply adds something new.
7. Do not use this skill to replace thread sequencing or campaign planning.
8. If the reply touches product truth, pair with product reality/audit skills before publishing.

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

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-20.
