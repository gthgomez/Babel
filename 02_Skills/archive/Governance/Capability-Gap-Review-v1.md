<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Capability Gap Review (v1.0)
**Category:** Governance
**Status:** Active
**Activation:** Load after a Babel-routed task, failed run, or repeated implementation pattern when the agent notices missing reusable guidance, repeated improvisation, or registry drift that suggests Babel lacks a needed capability.

---

## Purpose

Babel improves when it notices recurring friction and converts it into the right reusable layer.

This skill exists to answer one question:

`Was this friction caused by a missing Babel capability, or by using the wrong existing one?`

The answer is not always "make a new skill." Sometimes the fix is:

- update an existing skill
- adjust a domain architect
- tune routing
- add a task overlay
- improve docs or tooling

This skill prevents random skill sprawl by classifying the gap first.

---

## Step 1 — COLLECT THE FRICTION SIGNALS

Look for concrete signals from the task:

- repeated checklist written from scratch
- repeated command or validation sequence
- repeated safety caveat not captured anywhere reusable
- recurring ambiguity during Babel stack assembly
- repeated post-task note like "a skill would have helped here"
- stale secondary registry or routing metadata discovered during implementation

If none of those signals are present, stop. There may be no real capability gap.

---

## Step 2 — CLASSIFY THE GAP

Choose exactly one primary classification:

| Gap type | Use when |
|----------|----------|
| `existing_skill_update` | a current skill almost fits and should be expanded or clarified |
| `new_skill` | the workflow is reusable, non-obvious, and not already captured |
| `domain_update` | the problem is routing or default strategy, not a reusable sub-workflow |
| `task_overlay` | the guidance is bounded to a specific task family, not a general skill |
| `tooling_or_docs` | the gap is validation/tool support or missing repo instructions |
| `no_action` | the friction was one-off or user-specific |

**Rule:** Default to `existing_skill_update` over `new_skill` when the overlap is substantial.

---

## Step 3 — WRITE THE GAP RECEIPT

Produce a short receipt:

```text
CAPABILITY GAP RECEIPT
──────────────────────
Observed task: [one sentence]
Friction: [what had to be improvised]
Primary gap type: [classification]
Why current Babel was insufficient: [one sentence]
Recommended action:
- ...
```

If the result is `new_skill`, also include:

- proposed skill name
- target family (`Framework`, `Governance`, etc.)
- likely dependencies
- likely trigger phrases

If the result is `domain_update` or `task_overlay`, say that explicitly instead of forcing a skill.

---

## Step 4 — DECIDE WHETHER TO IMPLEMENT NOW

Implement immediately only when:

- the gap is clearly reusable
- the scope is bounded
- the overlap check is clean
- the skill can be registered and validated in the same change set

Otherwise, record the gap and stop at the receipt.

---

## Hard Rules

1. Never create a new skill just because a task was hard once.
2. Never treat routing ambiguity as proof that a new skill is required; sometimes the domain choice is wrong.
3. Never use a skill to patch over stale catalog metadata or missing validation.
4. If the right fix is an existing-skill update, say so plainly instead of inventing a sibling skill.
5. A capability gap is only real when you can name the repeated workflow or repeated failure it would prevent.
