<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Supabase RLS Drift Audit (v1.0)
**Category:** Governance
**Status:** Active
**Pairs with:** `skill_supabase_pg`, `skill_evidence_gathering`, `skill_ops_observability`, `domain_devops`
**Activation:** Load when a Supabase-backed system shows auth, RLS, schema-cache, partition, or environment drift symptoms. Typical triggers: 401/403/42501 errors, empty PostgREST errors, policies that look correct in code but fail live, partitioned tables, remote migration mismatch, or “works locally but not in hosted Supabase”.

---

## Purpose

This skill is for the class of incidents where the code looks correct but the live project does not
behave like the repo says it should.

Use it to answer five concrete questions:

1. Is the failure in code, live DB state, runtime deployment, or cache?
2. Do parent-table grants and policies actually exist on the live system?
3. Do active partitions inherit or separately require the same access?
4. Is the hosted project aligned with the local migration chain?
5. Has the repair been represented durably in git, not just applied manually?

---

## Step 1 — CAPTURE THE INCIDENT SURFACE

Collect:
- exact failing route or query path
- exact error/log payload
- timestamp and environment
- whether the runtime used a JWT-scoped client or service-role client
- whether the affected table is partitioned

Do not summarize away the original DB or PostgREST error. Preserve the code/message pair.

---

## Step 2 — COMPARE CODE INTENT TO LIVE STATE

Read the local evidence for:
- the calling code
- the migration(s) that should grant access
- the current schema snapshot if available
- any policy-rewrite or ownership-semantics migration touching the same table

Then inspect the live target for:
- `pg_policies`
- `information_schema.role_table_grants`
- `pg_class.relrowsecurity`
- current remote migration state

Minimum live checks:

```sql
select * from pg_policies where schemaname='public' and tablename in (...);
select * from information_schema.role_table_grants where table_schema='public' and table_name in (...);
select relname, relrowsecurity, relforcerowsecurity from pg_class ...;
```

For Supabase-managed projects, also check:
- `supabase migration list`
- whether the linked remote is behind local

---

## Step 3 — CHECK PARTITION DRIFT EXPLICITLY

If the table is partitioned:

1. identify the active partition(s)
2. inspect grants on the parent
3. inspect grants on the active partition(s)
4. inspect the partition-creation function or maintenance job

Do not assume parent grants prove child access in the hosted project.

Ask:
- Are existing partitions missing grants?
- Will future partitions inherit or be re-granted automatically?
- Is the app querying the parent table while the failure is really on the child partitions?

---

## Step 4 — CHECK SCHEMA CACHE AND DEPLOYMENT LAYERS

When errors mention missing tables in schema cache, empty PostgREST messages, or stale runtime behavior:

Classify the likely layer:
- `db_state`
- `schema_cache`
- `edge_function_deploy`
- `frontend_bundle`
- `env_misconfiguration`

Check:
- whether migrations were applied remotely
- whether the function/runtime was redeployed after code changes
- whether the frontend may still be serving an older bundle
- whether required env vars differ between local and hosted runtime

Typical non-code causes to call out explicitly:
- Supabase remote migration not applied
- PostgREST schema cache lag
- stale Edge Function deployment
- stale Vercel bundle or cached API URL
- incorrect linked project or wrong environment secrets

---

## Step 5 — REPAIR AND REPRESENT

If the issue is live drift:

1. create the smallest migration or config change that represents the fix
2. validate it locally
3. apply it remotely
4. verify the live state after apply
5. commit the repo artifact so the live repair is not undocumented

If the issue is deployment/cache:

1. record the required operational action
2. verify it actually happened
3. note whether code changes were unnecessary

---

## Output Contract

Summarize with:

1. `Observed failure`
2. `Code intent`
3. `Live effective state`
4. `Drift classification`
5. `Repair artifact`
6. `Remote verification`
7. `Remaining non-code risks`

Use one of:
- `CODE_BUG`
- `REMOTE_DB_DRIFT`
- `SCHEMA_CACHE_DRIFT`
- `DEPLOYMENT_DRIFT`
- `ENVIRONMENT_MISMATCH`
- `MIXED`

---

## Hard Rules

1. Never assume a Supabase auth failure is purely code-side until live grants and policies are inspected.
2. Never stop at the parent table when the failing relation is partitioned.
3. Never call a manual remote SQL fix “done” unless there is a migration or another durable repo artifact.
4. A successful `supabase db push` is not enough; verify the live effective grants/policies afterward.
5. If logs point to a hosted cache or deploy issue, say so clearly instead of forcing a code explanation.
6. If the frontend and backend can both be stale, classify both possibilities and clear them one by one.
