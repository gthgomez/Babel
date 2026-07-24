<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Supabase Exposed Schema Hardening (v1.0)
**Category:** Governance
**Status:** Active
**Pairs with:** `skill_supabase_pg`, `skill_supabase_rls_drift_audit`, `skill_evidence_gathering`, `skill_bcdp_contracts`
**Activation:** Load when a Supabase project may be exposing unsafe objects through the `public` schema or other PostgREST-exposed schemas. Typical triggers: broad grants, missing RLS, SECURITY DEFINER RPC overuse, materialized views in `public`, “database publicly exposed”, “lock down grants”, or “which public objects are safe to expose?”.

---

## Purpose

Use this skill to harden the exposed Supabase data plane without rewriting the whole backend.

The goal is to answer:

1. Which objects are exposed through PostgREST?
2. Which grants are broader than intended?
3. Which objects lack RLS or equivalent ownership enforcement?
4. Which objects should be customer-readable, service-only, or moved out of `public`?
5. What is the smallest durable migration set to fix the exposure?

---

## Step 1 — INVENTORY THE EXPOSED SURFACE

Collect:

1. exposed schemas from config
2. tables in exposed schemas
3. views/materialized views in exposed schemas
4. RPC functions callable by `anon` or `authenticated`
5. partitioned tables and child objects

Minimum live/schema checks:

```sql
select nspname, relname, relkind from pg_class join pg_namespace ...;
select * from information_schema.role_table_grants where table_schema='public';
select * from pg_policies where schemaname='public';
```

Do not stop at tables. Views, materialized views, partitions, and callable functions count.

---

## Step 2 — CLASSIFY EACH OBJECT

For every exposed object, classify it as exactly one of:

1. `customer_direct_read_ok`
2. `customer_direct_write_ok`
3. `rpc_only`
4. `service_role_only`
5. `move_out_of_public`

Then verify whether the current grants and RLS match that classification.

---

## Step 3 — CHECK RLS AND GRANTS TOGETHER

Hard rules:

1. A broad grant without RLS is exposure.
2. RLS without the intended grant may fail closed, but must still be understood.
3. Parent-table posture is not enough if partitions exist.
4. SECURITY DEFINER RPCs must validate scope internally and not rely on caller honesty.

For each object, record:

1. grant posture
2. RLS enabled or not
3. FORCE RLS or not
4. ownership policy source
5. whether access is direct or only through RPC

---

## Step 4 — DESIGN THE MINIMAL FIX

Prefer the smallest safe change:

1. revoke unsafe grants first
2. add explicit read grants only where necessary
3. enable RLS for direct customer-readable tables
4. add ownership policies
5. move internal objects out of exposed schema only if grants/RLS are not enough

When possible, preserve customer API contracts by fixing the data plane under the existing routes instead of redesigning the app.

---

## Step 5 — REPRESENT AND VERIFY

Every repair must be:

1. captured in a migration
2. applied locally
3. applied remotely
4. verified with effective live state, not just migration success

Verify:

1. direct JWT read attempts fail where they should
2. intentional customer reads still work
3. new partitions or future objects will not reintroduce the exposure

---

## Output Contract

Summarize with:

1. `Exposed object inventory`
2. `Unsafe grant/RLS mismatches`
3. `Minimal migration plan`
4. `Live verification results`
5. `Residual exposure risks`

Classify each finding as:

- `SAFE AS-IS`
- `FAILS CLOSED BUT MISCONFIGURED`
- `EXPOSED`
- `NOT VERIFIED`

---

## Hard Rules

1. Never treat “the app only uses RPCs” as sufficient if direct grants still expose the table or view.
2. Never ignore views or materialized views in `public`.
3. Never trust parent-table posture without checking partitions.
4. Never finish on local migration success alone; verify remote effective grants and policies.
5. If an internal object is not meant for customer reads, default to `service_role_only`.
