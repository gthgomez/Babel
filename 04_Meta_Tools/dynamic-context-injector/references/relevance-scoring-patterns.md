<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Relevance Scoring Patterns — Dynamic Context Injector

**Purpose:** Detailed heuristics, edge cases, and worked examples for the dynamic-context-injector skill. Load when scoring is ambiguous or when building automated scoring pipelines.

---

## 1. Semantic Match Scoring (40% weight)

### How to evaluate

Compare the task description against the skill's `description` field (from prompt_catalog.yaml) and its SKILL.md purpose + activation sections. Look for:

- **Entity overlap:** Same technologies (Supabase, Stripe, React, Godot), concepts (RLS, webhooks, consent), or workflows (CI/CD, export, migration)
- **Verb overlap:** Same action class (deploy, audit, test, harden, create, migrate)
- **Problem-class match:** Same failure mode or risk category (injection, drift, silent failure, state corruption)

### Scoring table

| Semantic Signal | Score Range | Example |
|-----------------|-------------|---------|
| Exact entity + verb match | 0.9–1.0 | Task: "harden Supabase RLS policies" → `skill_supabase_rls_drift_audit` |
| Same entity, different verb | 0.7–0.8 | Task: "add a new Supabase table" → `skill_supabase_rls_drift_audit` (RLS might not be in scope) |
| Same verb class, different entity | 0.5–0.6 | Task: "harden API error handling" → `skill_supabase_exposed_schema_hardening` (hardening overlap, different target) |
| Adjacent domain (same project) | 0.3–0.4 | Task: "fix Android billing" → `skill_google_play_store` (billing is adjacent but store skill may not be needed) |
| Different domain entirely | 0.0–0.2 | Task: "add Godot sprite" → `skill_react_nextjs` (no overlap) |

### Edge cases

- **Partial term match (false friend):** "Deploy" in a frontend task vs `domain_devops`. Frontend deploy (Vercel/Netlify) ≠ DevOps deploy (Docker/K8s). Score based on the infrastructure named, not just the verb.
- **Multi-domain tasks:** When the task spans two domains, score skills from both domains. Cross-domain skills (e.g., `skill_evidence_gathering` applies to both SWE and audit work) may score higher than single-domain skills.
- **Vague tasks:** If the task description is under 10 words with no technology named, mark most scores as [INFERRED] or [THESIS] and default to CONSERVATIVE mode.

---

## 2. Tag Alignment Scoring (25% weight)

### How to evaluate

Compare task-extracted concepts against the skill's catalog tags. Use the tag taxonomy from `prompt_catalog.yaml`:

| Task concept | Matching tags to look for |
|-------------|--------------------------|
| Database/SQL | `db:postgres`, `db:rls`, `db:supabase`, `utility:migration` |
| Security/auth | `governance:safety`, `utility:auth`, `utility:injection` |
| Observability | `utility:logging`, `utility:observability`, `utility:sfdipot` |
| Multi-agent | `utility:multi-agent`, `utility:pipeline`, `utility:swarm` |
| Mobile/Android | `platform:android`, `utility:play-store`, `utility:billing` |
| Game/Godot | `platform:godot`, `utility:gdscript`, `utility:mobile-perf` |
| Frontend | `platform:web`, `utility:a11y`, `utility:design` |
| Compliance | `utility:example_saas_backend`, `utility:compliance`, `utility:audit` |
| CLI/tooling | `utility:cli`, `utility:sandbox`, `utility:benchmark` |

### Scoring table

| Tag Overlap | Score |
|-------------|-------|
| 3+ exact tag matches | 0.9–1.0 |
| 2 exact tag matches | 0.7–0.8 |
| 1 exact match + adjacent tags | 0.5–0.6 |
| 1 exact match only | 0.3–0.4 |
| Adjacent/related tags only (no exact match) | 0.1–0.2 |
| No tag overlap | 0.0 |

---

## 3. Domain Default Strength (20% weight)

### How to evaluate

Check `prompt_catalog.yaml` for `default_for_domains` entries. A skill that is a declared default for the matched domain gets a baseline boost, but this alone does not justify inclusion.

| Status | Score |
|--------|-------|
| Explicit domain default + specific orchestrator rule also fired | 0.9–1.0 |
| Explicit domain default (no specific rule) | 0.6–0.7 |
| Not a domain default but used in adjacent domain | 0.3–0.4 |
| Not in any related domain's defaults | 0.0–0.1 |

**Important:** Domain default status prevents premature exclusion but does NOT guarantee inclusion. A domain-default skill that scores 0.2 on semantic match should still be dropped in BALANCED mode — the task simply doesn't need it.

---

## 4. Orchestrator Rule Specificity (15% weight)

### How to evaluate

Check whether a specific V9 orchestrator rule (beyond domain defaults) fired for this skill.

| Rule Type | Score |
|-----------|-------|
| Task-matched keyword rule (e.g., "Android TV" → `skill_android_tv_game_ux`) | 0.9–1.0 |
| Pipeline mode rule (e.g., `parallel_swarm` → `skill_workspace_locking`) | 0.9–1.0 (hard keep) |
| Domain default (generic) | 0.4–0.5 |
| No specific rule fired | 0.0 |

---

## Worked Examples

### Example 1: Straightforward SWE task (BALANCED mode)

**Task:** "Add error logging to the Stripe webhook handler in example_saas_backend"

**Domain:** `domain_swe_backend` | **Purpose:** `execution`

**Candidate skills (from orchestrator defaults + rules):**
- `skill_ts_zod` (domain default)
- `skill_supabase_pg` (domain default)
- `skill_ops_observability` (domain default)
- `skill_bcdp_contracts` (domain default)
- `skill_evidence_gathering` (domain default)

**Scoring:**

| Skill | Semantic (40%) | Tags (25%) | Default (20%) | Rule (15%) | Total | Keep? |
|-------|---------------|-----------|---------------|-----------|-------|-------|
| `skill_ops_observability` | 0.9 ("error logging" matches logging strategy) | 0.9 (utility:logging, utility:observability) | 0.7 | 0.5 | **0.80** | ✅ |
| `skill_ts_zod` | 0.5 (TypeScript webhook handler) | 0.5 | 0.7 | 0.5 | **0.55** | ✅ |
| `skill_supabase_pg` | 0.3 (example_saas_backend uses Supabase, but task is about webhooks) | 0.4 | 0.7 | 0.5 | **0.45** | ❌ |
| `skill_bcdp_contracts` | 0.2 (no contract work in task) | 0.2 | 0.7 | 0.5 | **0.35** | ❌ |
| `skill_evidence_gathering` | 0.5 (logging ≈ evidence) | 0.5 (utility:audit) | 0.7 | 0.5 | **0.55** | ✅ |

**Result:** 3 of 5 domain defaults kept. ~40% token savings.

### Example 2: Safety-critical task (CONSERVATIVE mode forced)

**Task:** "Implement the payment capture flow with idempotency keys"

**Domain:** `domain_swe_backend` | **Purpose:** `execution` | **Risk:** Payment = safety-critical → CONSERVATIVE

All domain defaults kept regardless of score (CONSERVATIVE rule). Additional high-relevance skills added:
- `skill_idempotency` (score 0.95 — exact entity + verb match on "idempotency keys")

**Result:** Domain defaults + 1 addition. No token savings, but no safety gaps.

### Example 3: Cross-domain task (AGGRESSIVE mode)

**Task:** "Profile the Godot tower defense game on Android — why is it dropping frames?"

**Domain:** `domain_godot_game_dev` | **Purpose:** `exploration` | **Budget:** tight

**Candidate skills:** Godot defaults (6 skills) + Android perf-adjacent skills (2 skills)

**Scoring highlights:**
- `skill_godot_performance_mobile`: 0.95 — exact match on "profiling", "frames", "Android"
- `skill_godot_gdscript_arch`: 0.4 — general architecture, task is about perf not architecture
- `skill_android_game_development`: 0.7 — Android + game + performance overlap
- `skill_godot_ui_theme`: 0.1 — no UI/theme work in task

**Result:** 3 of 8 skills kept. ~60% token savings for a diagnostic task where context focus matters more than exhaustiveness.

---

## Ambiguity Resolution

When two modes produce different judgments for the same skill at the boundary:

1. **Prefer inclusion** when the skill addresses a known failure mode of the task's domain (e.g., RLS drift audit for any Supabase mutation task — even if RLS isn't explicitly mentioned, it's a latent risk).
2. **Prefer exclusion** when the skill is a "nice to have" that doesn't address a concrete task requirement (e.g., a11y design skill for a backend API task — no plausible connection).
3. **When genuinely uncertain:** Keep the skill in CONSERVATIVE mode, drop in AGGRESSIVE mode, and in BALANCED mode keep it with a [THESIS] label and flag it for OBSERVE-mode post-execution validation.

---

## Integration with OBSERVE Mode

After execution, the Ops-Observability v2 OBSERVE mode should compare:
- **This manifest's predictions** (which skills were scored relevant/irrelevant)
- **Actual runtime activations** (which skills were actually invoked, which tool calls they drove)

This closes the relevance feedback loop:
- Skills scored high but never used → scoring heuristic may be inflating relevance
- Skills scored low but frequently needed → scoring heuristic has a blind spot
- Skills dropped that caused a failure → threshold was too aggressive for this task class

Feed these observations back into this skill's scoring heuristics (via ols-compiler hardening passes).

---

## Redundancy Elimination Patterns (AgentDropout-Inspired)

### When to Drop for Redundancy

Clear cases (drop the lower-scoring skill):
- Two skills both cover the same technology with the same action class (e.g., two different Supabase RLS skills both auditing policies)
- Two skills have identical tag sets but different descriptions (likely version variants or duplicates)
- A domain-default skill and a specific-rule skill cover the same ground; keep the specific-rule one (higher orchestrator specificity weight)

### When to Keep Despite Redundancy

Do NOT drop for redundancy when:
- Skills have a declared dependency or pairs_with relationship — they're designed to work together
- One skill covers safety/governance and the other covers implementation — they serve different layers
- Both skills score above 0.8 — they're both highly relevant; the task genuinely needs both perspectives
- The skills overlap in tags but not in semantic function (e.g., both tagged `utility:audit` but one audits code, the other audits prompts)

### Worked Example

Task: "Audit the Supabase RLS policies for security gaps"

Kept skills after threshold:
- skill_supabase_exposed_schema_hardening (score: 0.85)
- skill_supabase_rls_drift_audit (score: 0.78)
- skill_ops_observability (score: 0.60)
- skill_evidence_gathering (score: 0.55)

Redundancy check:
- skill_supabase_exposed_schema_hardening vs skill_supabase_rls_drift_audit:
  - Shared tags: 3 (db:supabase, db:rls, utility:audit)
  - Semantic overlap: BOTH audit Supabase RLS — one for exposed schema, one for drift
  - Verdict: KEEP BOTH. Different audit dimensions (exposure vs drift). Not redundant.
- skill_ops_observability vs skill_evidence_gathering:
  - Shared tags: 1 (utility:audit)
  - Semantic overlap: Partial (both capture runtime data)
  - Verdict: KEEP BOTH. Observability = runtime monitoring, evidence = structured audit trails. Different functions.

Result: 0 redundancy drops. All 4 skills cover distinct dimensions.

---

## Anti-Patterns to Avoid

1. **Score inflation from tag matching alone:** A skill with `utility:logging` isn't automatically relevant to every task that mentions "log." Check semantic overlap.
2. **Default-worship:** Domain default status is a signal, not a verdict. In BALANCED mode, if the skill doesn't match the task, drop it and justify why.
3. **False precision:** Scores to one decimal are inherently subjective. Don't spend more than 1-2 sentences justifying a score — the evidence label ([KNOWN] vs [INFERRED]) is more important than the exact number.
4. **Safety blindness:** Never drop safety skills (injection guards, state machines, observability) for tasks involving mutations, auth, payments, or external calls — even if they score low on semantic match. These are structural, not topical.
