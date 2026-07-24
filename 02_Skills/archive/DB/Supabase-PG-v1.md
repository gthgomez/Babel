<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Supabase & Postgres (v1.0)
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
