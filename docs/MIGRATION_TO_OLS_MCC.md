<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Migration Guide: Upgrading Babel Skills to OLS-MCC v4.2 Compliance

**Date:** 2026-06-19
**Status:** Active — apply to all new and modified skills
**Context:** The OLS-MCC meta-tool layer (`04_Meta_Tools/OLS-MCC/`) is now integrated into the repository. All skills in `02_Skills/` should be upgraded to meet OLS-MCC v4.2 PRODUCTION standards.

---

## Why Migrate

Pre-OLS-MCC skills were created before the create → test → audit loop existed. They may lack:
- **Boundaries** — explicit "this skill does NOT do X" declarations
- **Failure Behavior** — what happens when inputs are bad, tools fail, or scope is exceeded
- **Strategic Next Move** — the one-question discipline that closes every response
- **Handoff contracts** — explicit deferral to sister skills (ols-compiler, prompt-tester, etc.)
- **Evidence labels** — [KNOWN], [OBSERVED], [INFERRED], [THESIS] on claims
- **Catalog conflict declarations** — explicit `conflicts: [skill_*]` entries for contradictory guidance

Skills missing these sections are not broken — but they are less robust, less auditable, and harder to compose with other skills in multi-agent workflows.

---

## Migration Checklist

For each existing skill, verify these 8 items. Order by priority — top items have the highest ROI for the least effort.

### 1. Copyright Header (1 minute)

Every skill file must start with the Apache License 2.0 header block:

```markdown
<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
...
-->
```

**Action:** Copy the header from any v2 skill (e.g., `Ops-Observability-v2.md`) and paste at the top of the file.

### 2. Metadata Line (2 minutes)

Every skill must have a metadata line below the title with Category, Status, Pairs with, and Activation.

**Before (v1 pattern):**
```markdown
# Skill: My Skill (v1.0)

**Category:** Governance
**Status:** Active
```

**After (v2 pattern):**
```markdown
# Skill: My Skill (v1.0)

**Category:** Governance
**Status:** Active
**Pairs with:** `ols-compiler`, `skill_related_skill`
**Activation:** Load when [specific trigger scenarios].
```

### 3. Boundaries Section (5 minutes) — CRITICAL

Add a `## Boundaries — Do Not Overstep` section. This is the highest-ROI addition — it prevents scope creep and misuse.

**Template:**
```markdown
## Boundaries — Do Not Overstep

- Focus exclusively on [core purpose]. Do not [related-but-out-of-scope activity] — that is the role of [other skill].
- Do not duplicate [content already covered elsewhere].
- Never claim [safety/accuracy without evidence] without [evidence requirement].
- [Any other scope limitations specific to this skill].
```

**Example (from prompt-tester):**
```markdown
## Boundaries — Do Not Overstep

- Focus exclusively on testing, critique, and actionable recommendations. Do not create new prompts from scratch or perform comprehensive hardening/rewriting — that is the role of ols-compiler.
- Do not duplicate general model knowledge, full construction contracts, or specialized modules already covered elsewhere.
- When simulation is used, clearly label it as such and provide instructions for real execution if needed.
```

### 4. Failure Behavior Section (5 minutes) — CRITICAL

Add a `## Failure Behavior of This Skill` section. Name what happens when inputs are bad, tools fail, or scope is exceeded.

**Template:**
```markdown
## Failure Behavior of This Skill

- **[Specific failure scenario]**: [What the skill does — flag, escalate, redirect, ask].
- **[Another scenario]**: [Behavior].
- **Self-test**: [How this skill can validate itself].
```

At minimum, cover: invalid/missing input, scope exceeded, and tool/helper failure.

### 5. Strategic Next Move Section (2 minutes)

Add a `## Strategic Next Move` section. Every substantial response from this skill must end with one focused next-move question.

**Template:**
```markdown
## Strategic Next Move

Every substantial response must end with exactly one strategic next-move question focused on the single highest-leverage follow-up action or a clearly better alternative.
```

### 6. Handoff Declarations (3 minutes)

Update the "Pairs with" metadata line and add `dependencies` / `conflicts` to `prompt_catalog.yaml` where appropriate.

**Checklist:**
- [ ] Does this skill defer to another skill? → Add to "Pairs with" and `dependencies`.
- [ ] Does this skill contradict another skill if both are loaded? → Add to `conflicts`.
- [ ] Does this skill complement a sister skill? → Add to "Pairs with" (no catalog change needed if not a hard dependency).
- [ ] Does the sister skill reference this skill back? → If not, open a reciprocal issue.

### 7. Evidence Labels (ongoing)

Add evidence labels to claims, ratings, and predictions throughout the skill body.

**Replace:**
- "This is the best approach" → "[KNOWN] This is the best approach based on [source]"
- "This should work" → "[INFERRED] This should work — test with [scenario] to confirm"
- "X is deprecated" → "[KNOWN] X is deprecated as of [version] — see [source]"

### 8. Run Through the OLS-MCC Triad (15-30 minutes per skill)

After structural changes are applied:

1. **ols-compiler**: "Harden `[skill_path]` to OLS-MCC v4.2 PRODUCTION standards. Focus on any remaining gaps in Boundaries, Failure Behavior, and handoff contracts."
2. **prompt-tester**: "Test `[skill_path]` for adversarial robustness — injection resistance, role override, and multi-turn state drift."
3. **skill-auditor**: "Audit `[skill_path]` for production readiness. Produce a GREEN/YELLOW/RED verdict with prioritized recommendations."
4. **coherence-linter** (TARGETED): "Lint `[skill_path]` against other skills in its domain for contradictions and handoff gaps."

Aim for GREEN on skill-auditor before marking the migration complete.

---

## Migration Priority Tiers

Not all skills need immediate migration. Prioritize by impact:

### Tier 1 — Immediate (next 2 weeks)
Skills governing safety, compliance, auth, or multi-agent workflows:
- `skill_untrusted_input_guard`
- `skill_autonomous_agent_state_machine`
- `skill_async_task_delivery`
- `skill_workspace_locking`
- `skill_ops_observability` (already migrated to v2)
- `skill_idempotency`
- `skill_reject_loop_recovery`

### Tier 2 — High (next 4 weeks)
Skills loaded frequently (domain defaults, high-traffic paths):
- All Android store/skill skills (Play Store, App Bundle, Release Build, etc.)
- `skill_supabase_pg`, `skill_supabase_rls_drift_audit`
- `skill_ts_zod`
- `skill_react_nextjs`, `skill_react_vite`
- `skill_sse_streaming`, `skill_deno_edge_functions`

### Tier 3 — Standard (next 8 weeks)
All remaining skills in `02_Skills/`.

### Tier 4 — Optional
Skills that are rarely loaded, experimental, or candidate for deprecation.

---

## Already Migrated (v2 Compliant)

These skills were created or updated during the OLS-MCC integration and already meet v4.2 standards:

| Skill | Version | Status |
|-------|---------|--------|
| `ols-compiler` | v1.0 | GREEN — includes Boundaries, Failure Behavior, Strategic Next Move |
| `prompt-tester` | v1.0 | GREEN |
| `skill-auditor` | v1.0 | GREEN |
| `dynamic-context-injector` | v1.0 | GREEN |
| `coherence-linter` | v1.0 | GREEN |
| `ops-observability` | v2.0 | GREEN — dual-mode DESIGN + OBSERVE |
| `memory-curator` | v1.0 | GREEN — three-mode EXTRACT + SYNC + RETRIEVE |
| `skill-authoring` | v2.0 | GREEN — OLS-MCC triad in validation pipeline |
| `standards-currency-audit` | v2.0 | GREEN — OLS-MCC compliance as audit dimension |

---

## Verification

After migrating a skill, verify:

1. `tools/validate-catalog.ps1` passes (no structural issues introduced).
2. `skill-auditor` returns GREEN on the migrated skill.
3. `coherence-linter` (TARGETED) returns CLEAN or MINOR GAPS against domain peers.
4. The skill's `prompt_catalog.yaml` entry has updated `dependencies` and `conflicts` if handoffs were added.
5. The compiled min file is regenerated (if your workflow uses compiled mins).

---

## Getting Help

For any skill where the migration is unclear or where contradictions with other skills are discovered:

1. Activate `ols-compiler` with the skill and the gaps identified.
2. Activate `skill-auditor` for a structured audit before attempting migration.
3. Activate `coherence-linter` (DOMAIN scope) if cross-skill contradictions are suspected.
