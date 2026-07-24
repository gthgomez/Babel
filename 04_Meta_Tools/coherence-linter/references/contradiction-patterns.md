<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Contradiction Patterns — Coherence Linter

**Purpose:** Detailed contradiction taxonomies, known conflict classes, heuristic detection patterns, and worked examples for the coherence-linter skill. Load when linting is ambiguous or when building automated contradiction detection.

---

## 1. Rule-Level Contradiction Taxonomy

### Class A: Opposite Safety Defaults

Two skills give opposite guidance for the same safety-critical scenario.

**Detection pattern:**
- Both skills address the same operation class (auth, payment, permissions, data mutation).
- One uses FAIL_CLOSED / "deny by default" / "reject unless" language.
- Other uses FAIL_OPEN / "allow by default" / "accept unless" language.
- No context distinguishing when each applies (same scenario, opposite advice).

**Example:**
- Skill A: "Default to FAIL_CLOSED for all auth endpoints."
- Skill B: "Prefer FAIL_OPEN for auth to avoid lockout during incidents."
- Contradiction: Both apply to "auth endpoints" with no qualifier. Model can't know which to follow.

**Resolution:** Add a `conflicts` declaration. Or harmonize: "FAIL_CLOSED for auth mutations (login, password reset). FAIL_OPEN for auth reads (session validation) — with circuit breaker."

### Class B: Incompatible Numeric Defaults

Two skills specify different default values for the same parameter.

**Detection pattern:**
- Both skills name the same parameter (timeout, retry count, batch size, cache TTL).
- Numeric values differ by >50% or by an order of magnitude.
- Both claim to be the "default" or "recommended" value.

**Example:**
- Skill A: "Default timeout for external API calls: 30 seconds."
- Skill B: "Set external call timeout to 5 seconds — anything longer risks Lambda/edge function expiry."

**Resolution:** Add qualifiers to both: "30s for server-side calls. 5s for edge function / Lambda calls." Or pick one and cross-reference from the other.

### Class C: Overlapping Authority Claims

Two skills both claim authority over the same domain or decision.

**Detection pattern:**
- Both skills' descriptions or activation sections claim the same scope.
- Both say "this is the canonical/primary/authoritative source for X."
- Neither references or defers to the other.

**Example:**
- Skill A: "The canonical source for Supabase error handling patterns."
- Skill B: "Definitive guide to Supabase error handling and recovery."
- Contradiction: Same claim, no cross-reference. Which does the model trust?

**Resolution:** Merge into one skill with cross-references. Or split scope clearly: "Supabase error handling for Edge Functions" vs "Supabase error handling for Postgres/REST API."

### Class D: Mutually Exclusive "Always/Never" Rules

Two skills state universal rules that can't both be true.

**Detection pattern:**
- Both use "always," "never," "must," or "must not" language.
- Rules address the same action or pattern.
- Rules are logically incompatible (can't both be true simultaneously).

**Example:**
- Skill A: "Always use Zod schemas for API input validation — never use manual type guards."
- Skill B: "For performance-critical endpoints, use manual type guards instead of Zod to avoid schema compilation overhead."
- Contradiction: "Never use manual type guards" vs "use manual type guards for performance."

**Resolution:** Add qualifiers: "Always use Zod unless the endpoint is performance-critical (>1k req/s) and the schema is simple (≤5 fields) — then manual type guards are acceptable with a documented justification."

---

## 2. Version/API Conflict Taxonomy

### Class E: Incompatible Library Versions

Two skills recommend different major versions of the same library.

**Detection pattern:**
- Both skills name the same library or tool.
- Version pins or minimums differ by a major version.
- No migration guidance or version qualification.

**Example:**
- Skill A: "Use Next.js 14 App Router for all new projects."
- Skill B: "Next.js 15 with React 19 and `use` hook for data fetching."

**Resolution:** Add a version qualifier to one or both. Or add a migration note: "New projects: Next.js 15. Existing Next.js 14 projects: follow Skill A until migrated."

### Class F: Deprecated API vs Active Recommendation

One skill recommends an API that another skill marks as deprecated.

**Detection pattern:**
- Skill A recommends or uses API X.
- Skill B explicitly says "API X is deprecated — use Y instead."
- Or: Skill B demonstrates a pattern that relies on the deprecated API.

**Example:**
- Skill A: "Use `supabaseClient.auth.api.signUp()` for user registration."
- Skill B: "`auth.api.*` methods are deprecated in Supabase v2 — use `supabaseClient.auth.signUp()` directly."

**Resolution:** Update Skill A to match the current API. Add a staleness check to the currency audit schedule.

---

## 3. Handoff Gap Taxonomy

### Class G: Same Domain, No Relationship

Two skills clearly belong to the same domain or workflow phase but have no declared dependency, conflict, or pairs-with.

**Detection pattern:**
- Both skills share ≥2 tags or belong to the same `default_for_domains` list.
- Neither skill references the other in any form.
- Their descriptions suggest they address related or sequential concerns.

**Example:**
- `skill_supabase_pg` and `skill_supabase_rls_drift_audit` share domain and tags. If they had no relationship declared, this would be a gap.

**Resolution:** Add `dependencies` or `conflicts` to `prompt_catalog.yaml`. Add "Pairs with" to both skills' metadata.

### Class H: Asymmetric Reference

Skill A says "defer to Skill B for X" but Skill B doesn't acknowledge Skill A or the X handoff.

**Detection pattern:**
- Skill A explicitly names skill B with "defer to," "hand off to," "see also," or "pairs with."
- Skill B's content has no reciprocal mention of Skill A.
- The handoff is one-way — Skill B doesn't know Skill A exists.

**Example:**
- Skill A: "For adversarial testing, defer to prompt-tester."
- prompt-tester: Does not mention receiving handoffs from Skill A specifically (though it does reference ols-compiler).
- Not all one-way references are gaps — only when the handoff implies B should expect or prepare for A's output.

**Resolution:** Add a reciprocal reference in Skill B. Or accept the asymmetry if the relationship is genuinely one-directional.

### Class I: Dead Reference

A skill references another skill that doesn't exist in the catalog.

**Detection pattern:**
- Skill content contains "see also `skill_X`" or "pairs with `skill_Y`."
- `skill_X` or `skill_Y` is not found in `prompt_catalog.yaml`.

**Example:**
- Skill references `skill_legacy_auth_pattern` which was removed in a prior cleanup.

**Resolution:** Remove the dead reference. Or create the missing skill if it was accidentally deleted.

---

## 4. Worked Examples

### Example 1: TARGETED lint — adding new error-handling skill

**Target:** New skill `skill_error_recovery_patterns` (proposed, not yet in catalog).

**TARGETED comparison set:** Skills sharing tags `utility:recovery`, `utility:sfdipot`, `governance:safety`:
- `skill_ops_observability`
- `skill_idempotency`
- `skill_reject_loop_recovery`

**Findings:**
- CONFLICT with `skill_ops_observability`: New skill says "CIRCUIT_BREAKER is the default recovery strategy." Ops-Observability DESIGN mode says "RETRY_WITH_BACKOFF is the default; CIRCUIT_BREAKER only for consecutive failures." Contradiction on default strategy.
- GAP with `skill_reject_loop_recovery`: New skill covers recovery patterns after QA rejection — same workflow phase — but no handoff declared. Should add dependency or pairs-with.
- CLEAN with `skill_idempotency`: New skill explicitly defers idempotency justification to idempotency skill. Good handoff.

**Resolution:** (1) Harmonize the default strategy with ols-compiler. (2) Add `skill_error_recovery_patterns` as a dependency or pairs-with in `skill_reject_loop_recovery`.

### Example 2: DOMAIN lint — Android skills

**Scope:** All skills with `platform:android` or `utility:*` tags related to Android.

**Findings:**
- GAP between `skill_android_app_bundle` and `skill_android_release_build`: Both are domain defaults for `domain_android_kotlin`, both deal with release packaging, but no relationship declared. Should have `dependencies` (release build → app bundle, or vice versa).

### Example 3: ECOSYSTEM quick scan (low signal filtering)

**Scope:** All 100+ skills. To avoid O(n²) noise:
- Only flag CRITICAL pairs (safety/auth/financial contradictions).
- Only flag GAPs where skills share ≥3 tags and same `default_for_domains`.
- Skip INFO-level findings entirely.
- Expected output: 2-5 CRITICAL/CONFLICT, 10-20 GAPs.

---

## 5. Anti-Patterns to Avoid

1. **Over-flagging stylistic differences**: "Use tabs" vs "Use spaces" is not a contradiction. Only flag substantive conflicts where two instructions can't both be followed simultaneously.
2. **Treating one-way references as gaps**: Not every asymmetric reference needs a reciprocal. "Defer to X" from a consumer doesn't require X to list every consumer.
3. **Forcing catalog conflicts for every overlap**: Two skills can address the same domain from different angles without needing a `conflicts` declaration. Only add `conflicts` when loading both would actively contradict each other.
4. **Ecosystem scans on every commit**: ECOSYSTEM scope is expensive. Default to TARGETED. Suggest DOMAIN or ECOSYSTEM only when the change is broad or during scheduled health checks.
