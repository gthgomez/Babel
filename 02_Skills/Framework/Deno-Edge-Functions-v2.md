<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Deno & Supabase Edge Functions (v2.0)
**Category:** Framework / Runtime
**Status:** Active
**Last Verified:** 2026-04-25

---

## 1. Runtime Identity

Supabase Edge Functions run on the **Supabase Edge Runtime**, a Deno-compatible runtime with
TypeScript-first semantics. Treat it as edge/serverless TypeScript, not a long-running Node server:
- Use ESM `import`; do not use CommonJS `require()`.
- Prefer `Deno.env.get("KEY")` for secrets in Edge Functions.
- Use Web APIs and Deno APIs first. Node built-ins and `npm:` packages are supported where documented, but must be explicit dependencies.
- `__dirname` and `__filename` are not available as globals; avoid filesystem-relative runtime assumptions in edge handlers.

---

---

## 2. Dependency Management (Supabase Edge Runtime / Deno 2-compatible)

### The JSR Shift
- **Prefer explicit specifiers**: Use `npm:` for npm packages and `jsr:` for JSR packages. Avoid unpinned raw HTTPS imports in business logic files.
- **Function-local `deno.json`**: Use a function-level `deno.json` for dependencies and Deno settings when deploying isolated functions.

### Standard `deno.json` Structure
```json
{
  "imports": {
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2",
    "@std/http": "jsr:@std/http@1",
    "stripe": "npm:stripe@18"
  }
}
```

### Usage in Logic
```typescript
// Imports from import map aliases
import { createClient } from "@supabase/supabase-js";
import { serve } from "@std/http/server";
import Stripe from "stripe";
```

**Rules:**
- Always pin major versions, and pin minor/patch versions when reproducible builds matter.
- Use `npm:` specifiers only when a JSR native alternative does not exist.
- Run `deno install` to synchronize the `deno.lock` file.


---

## 3. Environment & Secrets

```typescript
// CORRECT
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const stripeKey   = Deno.env.get("STRIPE_SECRET_KEY")!;

// WRONG — never hardcode
const supabaseUrl = "https://example.com/api"; // ❌
```

**Rules:**
- All secrets via `Deno.env.get()`. Assert non-null with `!` or guard explicitly — missing env vars must fail loudly at startup, not silently at use.
- Local dev: set in `.env` (gitignored), loaded by `supabase start` or `--env-file`.
- Production: set via `supabase secrets set KEY=value`.
- Never log secret values. Log key names only (e.g., `"STRIPE_SECRET_KEY: present"`).

---

## 4. Request Handling Pattern

Every edge function entry point follows this exact pattern:

```typescript
import { serve } from "@std/http/server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  // 1. CORS preflight — must always be first
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 2. Parse body / headers
    const body = await req.json();

    // 3. Business logic

    // 4. Return response
    return new Response(JSON.stringify({ result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
```

**Rules:**
- OPTIONS preflight MUST be the first check. Missing it causes silent CORS failures in browsers.
- Always wrap in try/catch. An unhandled exception in an edge function returns a generic 500 with no body — extremely hard to debug.
- Use standard `Response` objects only. No Express `res.json()`, no Next.js `NextResponse`.
- Return JSON errors with a structured `{ error: string }` body, not raw exception objects.

---

## 5. Supabase Client Initialization

### The dual-client pattern (used in example_saas_backend `customer-api`)

```typescript
// Service role client — for auth bootstrap ONLY
const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// User JWT client — for all business data operations
const authHeader = req.headers.get("Authorization")!;
const supabaseUser = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_ANON_KEY")!,
  { global: { headers: { Authorization: authHeader } } }
);
```

**Rules:**
- Service role client touches auth bootstrap only (verify JWT, fetch user record). Never use it for business data reads/writes.
- All business data operations use the JWT-scoped `supabaseUser` client so RLS policies enforce tenant isolation.
- Never expose the service role key to the browser. It bypasses RLS entirely.

### JWT verification

```typescript
// CORRECT — delegate to Supabase
const { data: { user }, error } = await supabaseAdmin.auth.getUser(
  req.headers.get("Authorization")?.replace("Bearer ", "") ?? ""
);
if (error || !user) {
  return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
}

// WRONG — never manually verify JWT in application code
import { verify } from "https://deno.land/x/djwt/mod.ts"; // ❌ fragile, key management complexity
```

---

## 6. Type Checking & Verification

```bash
# Type-check all edge functions locally (Deno, not tsc)
deno check supabase/functions/**/*.ts

# Run a specific function locally
supabase functions serve gpc-signal --env-file .env

# Deploy
supabase functions deploy gpc-signal

# Deploy without JWT verification (for public endpoints like health-check)
supabase functions deploy health-check --no-verify-jwt
```

**Rules:**
- Use `deno check`, not `tsc --noEmit`. The two type checkers have slightly different behavior; `deno check` is authoritative for this runtime.
- Run `deno check` before deploying. Supabase's deploy pipeline type-checks automatically, but catching errors locally saves a round-trip.
- For functions that should be publicly accessible (no auth required), deploy with `--no-verify-jwt`. Functions deployed without this flag require a valid Supabase anon key in the header.

---

## 7. Edge Function Constraints

| Constraint | Value |
|---|---|
| Max execution time | 150s (Supabase default) |
| Max memory | 150MB |
| Persistent storage | None — stateless per-invocation |
| TCP sockets | Allowed (for DB connections) |
| File system | Read-only access to bundled files only |
| Background tasks | `EdgeRuntime.waitUntil()` for fire-and-forget after response |

**Implications:**
- No in-memory caching between invocations — use Postgres or KV store.
- DB connections are re-established per invocation (connection pooling handled by Supabase internally via PgBouncer).
- For long-running operations, respond early and use `EdgeRuntime.waitUntil()` or a separate worker queue.

---

## 8. High-Risk Zones

| Zone | Risk |
|------|------|
| CORS headers | Missing `OPTIONS` handler = silent browser failures |
| Service role key usage | Bypasses RLS — service role for auth bootstrap only |
| Unhandled exceptions | Generic 500 with no diagnostic body |
| Floating dependency versions | Upstream change breaks without notice |
| JWT manual verification | Key rotation, algorithm drift — always delegate to `supabase.auth.getUser()` |
| `--no-verify-jwt` on authenticated endpoints | Removes the auth gate entirely |

---

## Boundaries — Do Not Overstep
- This skill provides Babel-specific SSE/Edge Function conventions. It does not replace Supabase Edge Functions, Deno, or SSE protocol documentation.
- Runtime-specific guidance (timeouts, memory limits, API availability) must be verified against current platform documentation before use in production plans.

## Failure Behavior of This Skill
- **Referenced runtime limit or API is outdated:** Flag as STALE. Recommend web-search verification against current platform docs.
- **Streaming/edge pattern conflicts with another skill:** Activate `coherence-linter` to detect and resolve.
- **Platform behavior differs from documented pattern:** Flag as DRIFT. Recommend testing against current platform before proceeding.

## Strategic Next Move
After every substantial response, end with one strategic next-move question focused on the highest-leverage validation step.

## References
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening streaming/edge patterns.
- `skill_standards_currency_audit` (`02_Skills/Governance/Standards-Currency-Audit-v2.md`) — for scheduled re-verification of runtime limits and API references.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting contradictions with related skills.

---

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-19.
