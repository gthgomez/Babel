<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: X Thread Reply Strategy (v2.0)
**Category:** Governance
**Status:** Active
**Activation:** Load when the task is to design, draft, split, order, or refine X/Twitter threads, reply chains, quote replies, follow-up comments, and post-by-post conversation structure after an initial hook has been chosen.

---

## Purpose

Use this skill to decide how a message should unfold across X.

`X Marketing Manager` decides the campaign.
This skill decides the sequence.

Use it when the job is:
- turn one idea into a thread without overstuffing the first post
- decide whether a reply chain is better than a thread
- split proof, context, objection handling, and CTA into separate posts
- build a reply ladder after a hook post lands
- draft quote replies that support, correct, or extend an external post
- keep each reply doing one job

Pairs naturally with `skill_x_marketing_manager`.

---

## Workflow

### 1. Classify the surface

Decide which structure fits best:
- single post: one idea, one point
- thread: one argument needs 2+ connected beats
- reply chain: one post needs follow-up context after engagement begins
- quote reply: the conversation should attach to someone else’s post

Prefer the smallest structure that can carry the message.

### 2. Assign the post roles

For each post or reply, pick one role:
- hook
- proof
- context
- objection handling
- technical detail
- CTA
- engagement response

Do not let one post do two jobs unless the message is extremely short.

### 3. Set the order

Recommended thread order:
1. hook
2. proof
3. category split or core point
4. objection handling
5. context or caveat
6. CTA or next step

For replies:
- keep the first reply the strongest supporting detail
- use later replies for nuance, corrections, or added proof
- do not bury the main answer in reply 4

### 4. Control the density

Each post should be:
- readable on mobile
- one main thought
- short enough to scan quickly
- specific enough to stand alone

If a post needs semicolons, nested clauses, or a paragraph break to make sense, split it.

### 5. Decide what belongs off-thread

Move these out of the main thread when possible:
- deep technical evidence
- extra screenshots or detail shots
- dense caveats
- implementation notes
- internal jargon

Put them in replies, not in the opening post.

### 6. Return a usable structure

Always output:
- structure choice
- post-by-post outline
- final copy per post
- where to attach proof
- where to stop the thread

---

## Hard Rules

1. Do not force a thread when one post is enough.
2. Do not make the first post a wall of context.
3. Do not let replies drift into duplicate messaging.
4. Do not mix proof, caveat, and CTA in the same reply unless the reply is very short.
5. Do not make the thread longer than the audience needs.
6. Do not use quote replies as a substitute for a coherent original post.
7. Do not let technical detail outrun the reader’s attention span.
8. If the reply structure is for live publishing, verify the thread order after posting.

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
