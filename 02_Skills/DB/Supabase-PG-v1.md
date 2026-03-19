# Skill: Supabase & Postgres (v1.0)
**Category:** Database
**Status:** Active

## Relational Truth: Postgres
- **Single Source of Truth:** Supabase/PostgreSQL is the master record.
- **Immutable Migrations:** All schema changes must use SQL migration files in `supabase/migrations/`.
- **Naming:** Snake_case for tables and columns. Plural for tables.

## Security: Row Level Security (RLS)
- **RLS Mandatory:** Enabled on every table.
- **Policies:** Explicit policies for `anon`, `authenticated`, and `service_role`.
- **JWT Context:** Use `auth.uid()` for user-level isolation.
- **Privileged Writes:** Never allow client-side privileged writes. Use Edge Functions with `service_role` if necessary.

## Performance: Set-Based Logic
- **Efficient Queries:** Pushed to the DB where possible.
- **RLS Performance:** Avoid complex joins in RLS policies if they can be simplified.
- **Compute Placement:** Data-heavy logic should reside in PostgreSQL functions.
