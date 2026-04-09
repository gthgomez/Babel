<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Babel Catalog Tuning (v1.0)
**Category:** Governance
**Status:** Active
**Activation:** Load whenever a Babel prompt asset is added, renamed, moved, or re-scoped, especially after adding a new skill and whenever `prompt_catalog.yaml` and `02_Skills/Skill-Catalog.yaml` may have drifted.

---

## Purpose

In Babel, a new skill is only half the work. The other half is keeping the registries, routing hints, token budgets, and validation path aligned so the new capability is actually usable.

This skill exists to make post-addition tuning explicit instead of optional.

---

## Step 1 — REGISTRY SYNC

`prompt_catalog.yaml` is the canonical source of truth.

For every added or changed skill, verify:

- the file exists on disk
- the `prompt_catalog.yaml` entry exists
- the path matches exactly
- the id is unique
- `token_budget` is present
- `dependencies` and `conflicts` are intentional
- `tools/sync-skill-catalog.ps1` has been run
- `02_Skills/Skill-Catalog.yaml` mirrors the active skill set

**Rule:** `02_Skills/Skill-Catalog.yaml` is a secondary index, but it must not silently omit active skills.

---

## Step 2 — ROUTING AND OVERLAP TUNING

After adding a skill, ask:

| Question | Action |
|----------|--------|
| Should a domain load this by default? | update `default_skill_ids` only if common, not merely possible |
| Does the new skill overlap an existing one? | narrow one or merge instead of letting both sprawl |
| Are tags specific enough for discovery? | add task-shape tags, not generic filler only |
| Is the description triggerable? | mention concrete use cases and activation phrases |

If the new skill changes how Babel should reason about a task family, update the relevant router/domain docs in the same change set or explicitly record why not.

---

## Step 3 — VALIDATION LOOP

Minimum validation after catalog changes:

1. `powershell -ExecutionPolicy Bypass -File .\\tools\\sync-skill-catalog.ps1`
2. `powershell -ExecutionPolicy Bypass -File .\\tools\\validate-catalog.ps1`
3. if ids or routing behavior changed: `npm --prefix .\\babel-cli run test:orchestrator-routing`
4. if dependency expansion or catalog structure changed: `npm --prefix .\\babel-cli run test:resolver`

Use stronger validation when the change touches orchestrator outputs, resolver behavior, or public-export surfaces.

---

## Step 4 — POST-ADDITION TUNING NOTE

After each added skill, leave a short tuning note:

```text
CATALOG TUNING NOTE
───────────────────
Skill added: [id]
Registry sync: [done]
Default-domain changes: [none / listed]
Overlap risk: [low / medium / high]
Validation run:
- ...
Next follow-up:
- ...
```

This keeps Babel improvement iterative instead of one-shot.

---

## Step 5 — DRIFT PREVENTION

Watch for these drift patterns:

- skill file exists but is not in `prompt_catalog.yaml`
- skill is in `prompt_catalog.yaml` but missing from `02_Skills/Skill-Catalog.yaml`
- `Skill-Catalog.yaml` still reflects an older partial subset
- token budgets missing on new entries
- descriptions/tags too vague for routing

If drift is discovered during unrelated work, fix it in the same change set when the scope is still small and well understood.

---

## Hard Rules

1. Never add a Babel skill without running catalog validation afterward.
2. Never treat `02_Skills/Skill-Catalog.yaml` as allowed to drift indefinitely from the canonical catalog.
3. Never use bulk YAML rewriting that changes indentation contracts in `prompt_catalog.yaml`.
4. Never add a new skill and skip the overlap/default-domain review.
5. If validation is not run, say the tuning pass is incomplete.
