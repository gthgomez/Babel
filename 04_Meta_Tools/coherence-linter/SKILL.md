---
name: coherence-linter
description: Detect semantic contradictions between pairs of skills before they co-activate. Use when adding a new skill alongside existing ones, debugging unexpected agent behavior from conflicting instructions, or running periodic ecosystem health checks. Complements validate-catalog.ps1 (structural) and skill-auditor (individual semantic). Pairs with ols-compiler for conflict resolution.
status: ACTIVE
last_verified: 2026-07-03
metadata:
  version: "1.0"
  license: MIT
  copyright: 2025–2026 Jonathan Gomez Aguilar
---

# Coherence Linter (v1.0)

**Category:** Meta Tools
**Status:** Active
**Layer:** `04_Meta_Tools/` — pre-activation semantic contradiction detection
**Pairs with:** `skill-auditor` (individual skill audits), `validate-catalog.ps1` (structural validation), `ols-compiler` (resolution/harmonization), `dynamic-context-injector` (relevance routing may surface conflicting guidance)
**Activation:** Load before deploying a new or modified skill alongside existing skills, when debugging unexpected agent behavior that may stem from contradictory instructions, or during periodic ecosystem health checks. Also load as a pre-commit review step when adding or modifying any skill in `02_Skills/`.

---

## Purpose

Babel's catalog enforces exactly one structural conflict (`skill_react_vite` vs `skill_react_nextjs`). But semantic contradictions between skill *content* are undetected. Two skills can both load for the same task and give the model conflicting instructions — one says "always use FAIL_CLOSED for auth endpoints" while another says "prefer FAIL_OPEN for auth to avoid denial-of-service." The model receives both. Neither the catalog validator, the skill auditor, nor the prompt tester catches this because each checks individual skills, not pairs.

This skill scans skill pairs (or broader sets) for semantic contradictions across three dimensions:

1. **Rule-level contradiction**: Two skills state conflicting constraints, patterns, or defaults.
2. **Version/API conflict**: Two skills recommend incompatible versions of the same tool, library, or API.
3. **Handoff gap**: Two skills should coordinate but have no declared dependency, handoff, or pairs-with relationship.

It produces a structured contradiction report with severity, evidence, and resolution recommendations. This directly addresses Phase 2.2 of the OLS-MCC audit roadmap: "Automated Coherence Linting — Pre-activation or pre-deployment detection of contradictory rules across skills/policies."

---

## Activation & Scope

Infer when to activate:
- A new skill is being added or an existing skill is being substantially modified.
- A multi-skill task produced unexpected or inconsistent behavior.
- Periodic ecosystem health check (suggest to user monthly or after adding 5+ skills).
- Pre-commit review of any change to `02_Skills/` or `04_Meta_Tools/`.

**Scope levels** (infer from context, state explicitly):

| Scope | Scans | Use when |
|-------|-------|----------|
| `TARGETED` | A single new/changed skill against skills that share domain, tags, or dependencies | Adding or modifying one skill |
| `DOMAIN` | All skills within a domain or tag group | Domain-level refactor or audit |
| `ECOSYSTEM` | All skills in `02_Skills/` + `04_Meta_Tools/` | Periodic health check, pre-release |

Default to `TARGETED` for single-skill changes, `DOMAIN` for broader refactors.

---

## Core Instructions

When activated with a target skill or skill set:

### Step 1 — Load the Target Set

1. Read the target skill's full SKILL.md content.
2. Build the comparison set based on scope:
   - `TARGETED`: Skills sharing the target's `default_for_domains`, tags, or `dependencies`.
   - `DOMAIN`: All skills under a specified domain or tag group.
   - `ECOSYSTEM`: All skills in `02_Skills/` (may require loading `prompt_catalog.yaml` to enumerate).
3. For each comparison skill, load its SKILL.md (for TARGETED/DOMAIN) or its `prompt_catalog.yaml` description + tags (for ECOSYSTEM quick scan).

### Step 2 — Analyze Each Dimension

For each pair (target skill, comparison skill), check:

**Dimension A: Rule-Level Contradiction**
Scan both skills for hard rules, constraints, defaults, and patterns. Flag when:
- Same scenario, opposite advice (e.g., FAIL_CLOSED vs FAIL_OPEN for the same operation class).
- Incompatible defaults (e.g., one says "default timeout: 30s", another says "default timeout: 5s").
- Contradictory authority claims (e.g., both claim to be "the canonical source for error handling").
- Overlapping scope with different "always/never" rules.

**Dimension B: Version/API Conflict**
Check for explicit version pins, API references, and tool recommendations. Flag when:
- Two skills recommend different major versions of the same library.
- One skill recommends a deprecated API that another skill explicitly warns against.
- Different Node/Python/Kotlin version minimums for the same project class.
- One skill says "use X library" and another says "X is deprecated, use Y."

**Dimension C: Handoff Gap**
Check inter-skill relationships. Flag when:
- Two skills address the same domain or workflow phase but have no `dependencies`, `conflicts`, or "Pairs with" declaration.
- Skill A says "defer to skill B for X" but skill B doesn't mention X or skill A.
- A skill references another skill that doesn't exist (dead reference).
- Two skills should clearly NOT be loaded together (conflicting guidance) but have no `conflicts` declaration.

### Step 3 — Assign Severity

| Severity | Criteria | Example |
|----------|----------|---------|
| **CRITICAL** | Active contradiction on safety/auth/compliance path; model given opposite instructions | FAIL_CLOSED vs FAIL_OPEN on payment auth |
| **CONFLICT** | Clear contradiction on non-safety path; model must guess which instruction to follow | Different default timeout values for same operation |
| **GAP** | Missing handoff/deconfliction where skills overlap; potential for inconsistency | Same-domain skills with no dependency or pairs-with |
| **INFO** | Not a contradiction, but a coordination opportunity | Skills could benefit from cross-reference |

### Step 4 — Produce Report

Emit a structured coherence report (see Output Structure below). For each finding, include:
- Both skills' IDs and paths.
- Direct quotes from both as evidence.
- Severity and rationale.
- Recommended resolution (add `conflicts` declaration, harmonize guidance, declare handoff, or no action).

### Step 5 — Handoff for Resolution

For CRITICAL and CONFLICT findings, explicitly recommend activation of `ols-compiler` with the contradiction context to harmonize the conflicting skills. For GAP findings, recommend adding catalog-level `dependencies` or `conflicts` entries, plus updating the skills' "Pairs with" metadata.

---

## Output Structure

Use this consistent structure:

```
COHERENCE LINT REPORT
─────────────────────
Scope: [TARGETED / DOMAIN / ECOSYSTEM]
Target: [skill_id] (modified/added)
Compared against: N skills in [domain / ecosystem]
Pairs analyzed: P

Findings:
  CRITICAL: C  |  CONFLICT: F  |  GAP: G  |  INFO: I

---

CRITICAL — [1-line summary]
  Skill A: [skill_id] — "[direct quote from SKILL.md]"
  Skill B: [skill_id] — "[direct quote from SKILL.md]"
  Contradiction: [why they conflict — the scenario where both apply]
  Resolution: [add conflicts declaration / harmonize via ols-compiler / specific edit]

CONFLICT — [1-line summary]
  ... (same structure)

GAP — [1-line summary]
  ...

---

Overall Coherence: CLEAN / MINOR GAPS / CONFLICTS DETECTED / CRITICAL ISSUES

Handoff:
  [If conflicts found: "Activate ols-compiler with this report to harmonize the N conflicting skills."
   If gaps only: "Add the recommended catalog entries; no ols-compiler pass needed."
   If clean: "No action required."]
```

---

## Boundaries — Do Not Overstep

- **This skill detects contradictions — it does not resolve them.** Hand off CRITICAL and CONFLICT findings to `ols-compiler` for harmonization. GAP findings can be resolved by editing catalog entries directly.
- **This skill checks semantic content, not catalog structure.** Catalog structure (duplicate IDs, missing files, dependency cycles) is handled by `validate-catalog.ps1`. Run that first; run this for what it can't catch.
- **Do not flag stylistic differences as contradictions.** "Use tabs" vs "Use spaces" is style. "Use FAIL_CLOSED" vs "Use FAIL_OPEN for auth" is a contradiction. Only flag substantive conflicts.
- **ECOSYSTEM scope is expensive.** Only run on explicit user request. Default to TARGETED or DOMAIN.
- **False positives are possible.** When uncertain, label as [THESIS] and recommend human review rather than automatic resolution.

---

## Failure Behavior of This Skill

- **Target skill has no content (empty or placeholder):** Report as UNSCORABLE. Require substantive content before linting.
- **Comparison set is empty (no skills share domain/tags):** Report as CLEAN with note: "No overlapping skills found — target is isolated. No contradictions possible."
- **ECOSYSTEM scan would exceed 100+ pairs:** Offer to scope down to DOMAIN or TAGGED subsets. Full ecosystem pairwise scan is O(n²) and may produce many low-signal GAP findings.
- **Ambiguous finding (borderline contradiction):** Label as [THESIS], present both interpretations, and flag for human review. Do not force a CRITICAL/CONFLICT label on borderline evidence.
- **Self-test:** This skill should be linted against `skill-auditor` and `ols-compiler` (its closest neighbors in the meta-tool layer) to verify no contradictions in their handoff contracts.
- **Dead references:** If a skill references another skill by ID but that ID is not in `prompt_catalog.yaml`, flag as GAP with severity escalated to CONFLICT (the reference is actively misleading).

---

## References

- `references/contradiction-patterns.md` — detailed contradiction taxonomies, known conflict classes, heuristic patterns, and worked examples.
- `prompt_catalog.yaml` — canonical source for skill descriptions, tags, dependencies, and conflicts. Always load to identify the comparison set.
- `validate-catalog.ps1` — run first for structural validation before semantic linting.
- `ols-compiler` — for harmonizing skills with CRITICAL or CONFLICT findings.
- `skill-auditor` — for deeper individual skill quality audits (complementary to this pairwise analysis).

## Strategic Next Move

After every coherence report, end with exactly one strategic next-move question: for CRITICAL/CONFLICT findings, ask whether to hand off to ols-compiler for harmonization; for GAP-only findings, ask whether to add the recommended catalog entries; for CLEAN reports, suggest the next highest-value Phase 2 item.

---

**Design note:** This skill implements Phase 2.2 of the OLS-MCC audit roadmap. It fills the gap between `validate-catalog.ps1` (structural validation) and `skill-auditor` (individual semantic audit) by detecting cross-skill contradictions. It follows the OLS-MCC meta-tool pattern: lean activation layer, detailed heuristics in references/, explicit Boundaries, Failure Behavior, and handoff contracts to sister meta-tools.
