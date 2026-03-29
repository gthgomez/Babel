# First Success

This is the shortest practical way to understand what Babel changes.

## User Request

```text
Use Babel to build a SaaS backend with auth and Stripe subscriptions. Read BABEL_BIBLE.md first, assemble the right instruction stack, then continue.
```

## Without Babel

- You can get a plausible but mismatched plan: one service for auth, another for data, and billing added as an afterthought.
- Important architecture choices arrive late, after the model has already started suggesting implementation details.
- Two different runs can drift because the system-level stack was never made explicit up front.

## With Babel

Babel routes that same request into a clean, governed stack before the model starts doing deeper work:

- Behavioral OS: execution gates and evidence discipline
- Domain Architect: `domain_swe_backend`
- Skills: database and validation rules such as `skill_supabase_pg` and `skill_ts_zod`
- Model Adapter: selected for the active model surface
- Project Overlay: loaded only if the task belongs to a known project

Key decisions Babel helps lock in early:
- relational backend patterns instead of a vague "pick any backend service" answer
- auth, database, and billing treated as one system, not three disconnected suggestions
- stricter API and webhook validation at the boundaries

Then Babel resolves that stack into the exact prompt files to load before the model starts working.

In the public repo, you can preview that result deterministically with:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -PipelineMode verified `
  -Format json
```

Reference output:

- `examples/manifest-previews/backend-verified.json`

## Why This Stack?

- Auth, subscriptions, and backend data are tightly linked, so Babel treats them as one architecture problem instead of separate feature picks.
- Supabase/Postgres-style guidance fits better than a loose schemaless default when the task implies auth, payments, and durable relational data.
- Validation skills matter because billing and auth flows usually fail at boundaries, not just in business logic.

## What Would Likely Go Wrong Without Babel?

- Auth and payments could be chosen independently, leaving the account model inconsistent.
- The model could recommend a convenient but weak stack for a relational SaaS product with subscriptions.
- Webhook and API validation could be under-specified until bugs appear.
- The answer could jump into implementation before the stack and constraints are settled.
