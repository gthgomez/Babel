---
name: catalog-validate-all
description: >
  Run the catalog validation trio (validate-catalog + audit-skill-disk-drift +
  test-domain-default-policy) as a single unified check. Use after any catalog
  or routing change. Produces a pass/fail table with per-tool summaries.
---

# /catalog-validate-all

Run all three post-catalog-change validations together and interpret failures
into actionable fixes.

Contract: invokes `tools/validate-all.ps1`.

## Triggers

| Input | Behavior |
|-------|----------|
| `/catalog-validate-all` | Run all three validations, full output |
| `/catalog-validate-all --quiet` | Summary table only |
| "validate catalog", "run catalog checks", "check catalog" | Same as default |

## Workflow

1. Run `pwsh tools/validate-all.ps1` (or with `-Quiet`)
2. Review the summary table
3. If any tool fails, interpret the output:

### validate-catalog failures
- "File referenced but missing" → the file was moved/deleted without updating `prompt_catalog.yaml`
- "Duplicate version" → two entries claim the same version
- Fix: update `prompt_catalog.yaml` with correct paths/versions

### audit-skill-disk-drift failures
- "SKILL.md on disk not in catalog" → a skill file exists but isn't registered
- "Catalog entry points to missing file" → the catalog references a deleted file
- Fix: either add the skill to `prompt_catalog.yaml` or remove the orphaned file

### test-domain-default-policy failures
- "Domain missing default_skill_ids" → a domain architect lacks default skills
- Fix: review `02_Domain_Architects/<domain>/` and add `default_skill_ids`

## When to Run

- After any change to `prompt_catalog.yaml`
- After adding, moving, or deleting files in `01_Behavioral_OS/`, `02_Domain_Architects/`, `02_Skills/`
- Before committing catalog/routing changes (consider as a pre-commit hook)
- After `/handoff-resume` when the prior session touched the catalog

## Related

- `ratchet-preflight` — pre-push file-size budget check
- `ci-dry-run` — full local CI simulation
