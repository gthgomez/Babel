<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Skill Authoring (v2.0)

**Category:** Governance
**Status:** Active
**Supersedes:** `skill_skill_authoring` v1.0 (compiled min only — this is the first full-source version)
**Pairs with:** `ols-compiler`, `prompt-tester`, `skill-auditor`, `coherence-linter`, `dynamic-context-injector`
**Activation:** Load when the task is to create, update, split, merge, or register a Babel skill, especially after a run exposed repeated improvised guidance or a missing reusable workflow.

---

## Purpose

Every Babel skill must be: justified, minimal, correctly placed, cataloged, and validated. This skill codifies the 5-step workflow from fit-testing through OLS-MCC compliance. It ensures new skills don't become dead weight in the catalog and existing skills don't silently overlap.

---

## Step 1 — FIT TEST

Before creating a new skill, confirm it passes all four gates:

| Gate | Question | Required Answer |
|------|----------|-----------------|
| Reusable | Is the workflow reusable across tasks? | Yes — likely repeated across multiple runs |
| Non-obvious | Is the guidance non-obvious to a strong base model? | Yes — the model wouldn't reliably infer this on its own |
| Non-trivial | Is the workflow bigger than a one-line reminder? | Yes — it requires structure, rules, or a checklist |
| Right layer | Is this better as a skill than a domain architect, overlay, or tool script? | Yes — it's reusable technical guidance, not routing policy or project context |

**Fails the fit test if:**
- The behavior belongs inside an existing skill (revise that skill instead).
- The need is actually a domain-routing issue (update the orchestrator).
- The task is one-off and not reusable (use a task overlay).
- The content is just project context or policy copy (use a project overlay).

---

## Step 2 — CHOOSE THE SHAPE

| Decision | Guidance |
|----------|----------|
| Folder path | Place it in the most specific existing family: `Governance/`, `Cognition/`, `Framework/`, `DB/`, `Lang/`, `UI/`, `Mobile/`, `Payments/` |
| File name | `Name-v1.md` — ASCII, stable noun phrase, version suffix |
| Catalog ID | `skill_*` aligned to the file name (lowercase, underscores) |
| Scope | Narrow enough to avoid overlap, wide enough to justify existence |

**Rule:** Prefer a small, sharp skill over a broad skill that quietly overlaps three others. If you can't describe the skill's unique contribution in one sentence, the scope is too broad.

---

## Step 3 — WRITE THE SKILL

Every Babel skill must include these sections (per OLS-MCC v4.2 PRODUCTION standards):

1. **Copyright header** — license block, MIT + attribution
2. **Metadata line** — Category, Status, Pairs with, Activation
3. **Purpose** — Why this skill exists, what failure it prevents
4. **Activation condition** — When to load (specific triggers)
5. **Workflow or checklist** — Step-by-step instructions the model can follow
6. **Hard rules** — Non-negotiable constraints
7. **Boundaries — Do Not Overstep** — What this skill explicitly does NOT do, and what to hand off
8. **Failure Behavior** — What happens when inputs are bad, tools fail, or scope is exceeded
9. **Strategic Next Move** — Every substantial response ends with one focused next-move question
10. **References** — Links to related skills, reference files, and catalog entries

**Content rules:**
- Explain what Babel would not reliably infer on its own.
- Avoid generic engineering advice the base model already knows.
- Avoid long tutorials — prefer checklists and decision tables.
- Avoid duplicating a neighboring skill verbatim — cross-reference instead.
- Offload detailed patterns, examples, and schemas to `references/` files.
- Keep the SKILL.md under 350 lines for skills with references; under 500 lines hard limit.

---

## Step 4 — REGISTER THE SKILL

Required registration surfaces:

1. **`prompt_catalog.yaml`** — canonical source of truth. Add entry with:
   - `id` (skill_*)
   - `layer: skill`
   - `path` (relative to repo root)
   - `description` (activation triggers + what it does)
   - `status: active`
   - `tags` (at least one `utility:*` tag)
   - `dependencies` (skill IDs this skill needs loaded first)
   - `conflicts` (skill IDs that must NOT load alongside this one)
   - `token_budget` (estimated token cost when loaded)

2. **`tools/validate-catalog.ps1`** — validate `prompt_catalog.yaml` (the sole catalog; the former secondary mirror was eliminated 2026-06-29).

---

## Step 5 — VALIDATE

Validation pipeline (run in order):

1. Run `tools/sync-skill-catalog.ps1` — regenerates the secondary catalog.
2. Run `tools/validate-catalog.ps1` — checks for duplicate IDs, missing files, dependency cycles.
3. Confirm the new file path exists and is cataloged in both YAML files.
4. If routing or IDs changed, run the relevant `babel-cli` routing/resolver test.
5. Verify the skill did not create an overlap that should have been a revision to an existing skill.

**OLS-MCC compliance validation (v2.0 addition):**

6. Activate `ols-compiler` on the new skill for hardening — it enforces PRODUCTION standards on frontmatter, progressive disclosure, authority order, and robustness sections.
7. Activate `prompt-tester` for adversarial testing — check injection resistance, role override, multi-turn state drift, and frontmatter validity.
8. Activate `skill-auditor` for semantic audit — it produces a structured GREEN/YELLOW/RED verdict with prioritized hardening recommendations.
9. Activate `coherence-linter` (TARGETED scope) to check for contradictions between the new skill and existing skills in the same domain.
10. After the skill's first production run, activate `ops-observability` OBSERVE mode to capture runtime activation, drift, and cost data — feed back into ols-compiler for re-hardening.

### Skill Authoring Receipt

After completing all steps, produce this receipt:

```
SKILL AUTHORING RECEIPT
───────────────────────
Skill: [id]
Path: [path]
Why it exists: [one sentence]
Overlap check: [PASS / NEEDS MERGE]
Catalog registration: [DONE / MISSING]
Structural validation: [validate-catalog.ps1 result]
OLS-MCC compliance:
  ols-compiler: [PASS / NEEDS HARDENING]
  prompt-tester: [PASS / VULNERABILITIES FOUND]
  skill-auditor: [GREEN / YELLOW / RED]
  coherence-linter: [CLEAN / GAPS FOUND]
```

---

## Hard Rules

1. Never create a Babel skill without cataloging it in `prompt_catalog.yaml`.
2. Never leave `02_Skills/Skill-Catalog.yaml` stale after adding or renaming a skill.
3. Never use a new skill to smuggle in domain-architect behavior or project overlay context.
4. Never add a skill whose only content is generic best practices a base model already knows.
5. Never skip token-budget assignment for a new skill.
6. **New in v2.0:** Every new or substantially modified skill must pass through the OLS-MCC triad (ols-compiler → prompt-tester → skill-auditor) before being marked `status: active`.
7. **New in v2.0:** Every skill must include Boundaries, Failure Behavior, and a Strategic Next Move section.
8. **New in v2.0:** Skills with overlapping domains or tags must declare `dependencies` or `conflicts` in `prompt_catalog.yaml` — no silent overlaps.

---

## Boundaries — Do Not Overstep

- This skill defines the creation workflow. It does not create, harden, test, or audit skills — delegate those to ols-compiler, prompt-tester, and skill-auditor.
- This skill does not replace `validate-catalog.ps1` or `sync-skill-catalog.ps1` — it tells you WHEN to run them.
- This skill does not define catalog schema — that lives in `prompt_catalog.yaml` and `babel-cli/src/control-plane/catalog.ts`.

---

## Failure Behavior of This Skill

- **FIT TEST fails for a proposed skill:** Recommend revising an existing skill, updating the orchestrator, or using a task overlay. Do not force creation.
- **Skill overlaps with existing skill:** Flag the overlap with specific evidence (which skill, which section). Recommend merging into the existing skill or splitting scope.
- **Catalog registration fails validation:** Iterate on the catalog entry until `validate-catalog.ps1` passes. Do not proceed with an unvalidated catalog.
- **OLS-MCC triad finds issues:** Do not mark the skill `active` until all three verdicts are GREEN (or YELLOW with documented accept-risk). RED or GRAY = blocked.

---

## References

- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening new skills to PRODUCTION standards.
- `prompt-tester` (`04_Meta_Tools/OLS-MCC/prompt-tester/SKILL.md`) — for adversarial testing before activation.
- `skill-auditor` (`04_Meta_Tools/OLS-MCC/skill-auditor/SKILL.md`) — for semantic audit and GREEN/YELLOW/RED verdict.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for cross-skill contradiction detection.
- `dynamic-context-injector` (`04_Meta_Tools/dynamic-context-injector/SKILL.md`) — for validating that the skill's description and triggers score well for relevance routing.
- `prompt_catalog.yaml` — canonical catalog schema and registration target.
- `tools/validate-catalog.ps1` — structural validation script.
- `tools/sync-skill-catalog.ps1` — catalog regeneration script.

## Strategic Next Move

After every skill authoring receipt, end with exactly one strategic next-move question: if the skill is new, ask whether to run the OLS-MCC triad; if the triad found issues, ask whether to harden with ols-compiler; if GREEN, suggest the next skill to create or audit.

---

**Design note:** This v2.0 is the first full-source version of the skill-authoring workflow. It supersedes the compiled-min-only v1.0 and retrofits the 5-step workflow with OLS-MCC v4.2 compliance requirements, explicit Boundaries, Failure Behavior, and handoff contracts to the full meta-tool ecosystem (ols-compiler, prompt-tester, skill-auditor, coherence-linter, dynamic-context-injector, ops-observability). This directly implements Phase 2.4 of the OLS-MCC audit roadmap.
