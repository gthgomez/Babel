<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Supabase & Postgres (v2.0)
**Category:** Database
**Status:** Active
**Last Verified:** 2026-04-25

## Relational Truth: Postgres
- **Single Source of Truth:** Supabase/PostgreSQL is the master record.
- **Declarative Schema**: Prefer schema files in `supabase/schemas/` plus generated migrations. Use `supabase db diff -f <migration_name>` to generate migrations, review the SQL, then apply with `supabase migration up` locally and `supabase db push --dry-run` before remote deployment.
- **Naming**: `snake_case` for tables and columns. Plural for tables (e.g., `audit_logs`).

## Security: Row Level Security (RLS)
- **RLS Mandatory**: Enabled on every table. Default to `DENY ALL` if no policy exists.
- **Policy Granularity**: Separate policies for `SELECT`, `INSERT`, `UPDATE`, and `DELETE`.
- **JWT Context**: Use `auth.uid()` or custom JWT claims via `auth.jwt()`.
- **Security Definer Functions**: Use `SECURITY DEFINER` only when necessary to bypass RLS for specific logic (e.g., auto-creating profiles on signup). Set `search_path = public`.

## Client Resiliency (2026)
- **Automatic Retries**: Leverage built-in exponential backoff in the Supabase JS/TS client for transient network/DB errors.
- **Realtime Invariants**: Ensure every table has a primary key and REPLICA IDENTITY FULL if using Realtime filters.
- **Stripe Data Access**: Use Supabase's official Stripe Sync Engine or Stripe FDW/wrapper only after verifying project availability and credential storage. Stripe foreign tables are not webhook substitutes for event-driven entitlement changes.

---

## Boundaries — Do Not Overstep
- This skill provides Babel-specific technical guidance. It does not replace official Supabase/PostgreSQL/TypeScript documentation.
- Version-specific guidance must be verified against current stable releases before use in production plans. Referenced API patterns may have changed since last verification.

## Failure Behavior of This Skill
- **Referenced API or version is outdated:** Flag as STALE. Recommend web-search verification against current documentation before proceeding.
- **Guidance conflicts with another skill's recommendation:** Activate `coherence-linter` to detect and resolve the contradiction. Do not silently pick one.
- **Skill is loaded for a task outside its domain:** Boundaries section defines scope limits. Redirect to the appropriate domain skill.

## Strategic Next Move
After every substantial response, end with one strategic next-move question focused on the highest-leverage validation step.

## References
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening technical guidance against API changes.
- `skill-auditor` (`04_Meta_Tools/OLS-MCC/skill-auditor/SKILL.md`) — for auditing skill currency.
- `skill_standards_currency_audit` (`02_Skills/Governance/Standards-Currency-Audit-v2.md`) — for scheduled re-verification of version pins and API references.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting contradictions with related skills.

---

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-19.
