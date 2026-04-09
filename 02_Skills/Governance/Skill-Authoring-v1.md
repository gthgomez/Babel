<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Skill Authoring (v1.0)
**Category:** Governance
**Status:** Active
**Activation:** Load when the task is to create, update, split, merge, or register a Babel skill, especially after a run exposed repeated improvised guidance or a missing reusable workflow.

---

## Purpose

Not every pain point deserves a new skill. But when a task keeps requiring the same non-obvious workflow, Babel needs a reusable skill instead of another one-off patch.

This skill exists to keep new skills:

- justified
- minimal
- correctly placed
- cataloged
- validated

It pairs naturally with `skill_capability_gap_review` for detection and `skill_babel_catalog_tuning` for post-addition cleanup.

---

## Step 1 — FIT TEST

Before authoring a skill, answer:

| Question | Good signal for a skill |
|----------|-------------------------|
| Is the workflow reusable across tasks? | yes, likely repeated |
| Is the guidance non-obvious to a strong base model? | yes |
| Is the workflow bigger than a one-line reminder? | yes |
| Is this better as a skill than a domain architect, overlay, or tool script? | yes |

Do **not** create a new skill if:

- the behavior belongs inside an existing skill
- the need is actually a domain-routing issue
- the task is one-off and not reusable
- the content is just project context or policy copy

---

## Step 2 — CHOOSE THE SHAPE

Lock these decisions before writing:

| Field | Rule |
|-------|------|
| folder path | place it in the most specific existing family (`Framework`, `Governance`, `DB`, `Lang`, `UI`, `Mobile`, `Payments`) |
| file name | `Name-v1.md` with ASCII and stable noun phrase |
| catalog id | `skill_*` id aligned to the file name |
| scope | narrow enough to avoid overlap, wide enough to justify existence |
| dependencies | only declared when another skill is truly required for correct use |

**Rule:** Prefer a small, sharp skill over a broad skill that quietly overlaps three others.

---

## Step 3 — WRITE THE SKILL

Every Babel skill should contain:

1. activation line
2. purpose section
3. a short workflow or checklist
4. hard rules

Keep it lean:

- explain what Babel would not reliably infer on its own
- avoid generic engineering advice
- avoid long tutorials
- avoid duplicating a neighboring skill verbatim

Use imperative language. Write for another agent, not for a human README.

---

## Step 4 — REGISTER THE SKILL

A new or renamed skill is not real until registration is complete.

Required registration surfaces:

1. `prompt_catalog.yaml` — canonical source of truth
2. `tools/sync-skill-catalog.ps1` — regenerate the secondary skill index from the canonical catalog
3. `02_Skills/Skill-Catalog.yaml` — generated secondary skill index

For `prompt_catalog.yaml`, add:

- `id`
- `layer: skill`
- `path`
- `description`
- `status`
- `tags`
- `dependencies`
- `conflicts`
- `token_budget`

If the skill should be auto-loaded by a domain, update that domain's `default_skill_ids` only when the pairing is truly common.
After the catalog edit, run `tools/sync-skill-catalog.ps1` instead of hand-maintaining the secondary index.

---

## Step 5 — VALIDATE

Minimum validation after authoring:

1. run `tools/sync-skill-catalog.ps1`
2. run `tools/validate-catalog.ps1`
3. confirm the new file path exists and is cataloged
4. if routing or ids changed, run the relevant `babel-cli` routing/resolver test
5. verify the skill did not create an overlap that should have been a revision to an existing skill

When the skill is complete, emit:

```text
SKILL AUTHORING RECEIPT
───────────────────────
Skill: [id]
Path: [path]
Why it exists: [one sentence]
Overlap check: [PASS / NEEDS MERGE]
Catalog registration: [DONE / MISSING]
Validation: [commands run]
```

---

## Hard Rules

1. Never create a Babel skill without cataloging it in `prompt_catalog.yaml`.
2. Never leave `02_Skills/Skill-Catalog.yaml` stale after adding or renaming a skill.
3. Never use a new skill to smuggle in domain-architect behavior or project overlay context.
4. Never add a skill whose only content is generic best practices a base model already knows.
5. Never skip token-budget assignment for a new skill.
