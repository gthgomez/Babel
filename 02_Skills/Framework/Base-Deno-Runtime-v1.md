<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
-->

# Skill: Base Deno Runtime (v1.0)
**Category:** Framework / Runtime
**Status:** Active

## 1. Runtime Identity & ES Imports
Supabase Edge Functions run on the **Supabase Edge Runtime**, a Deno-compatible runtime:
- Use ESM `import`; do not use CommonJS `require()`.
- Prefer `Deno.env.get("KEY")` for secrets. Assert non-null with `!`.
- No filesystem-relative runtime assumptions in edge handlers.

## 2. Dependency Management & JSR
- Prefer explicit specifiers: Use `npm:` for npm packages and `jsr:` for JSR packages.
- Define shared dependencies in a standard `deno.json` import map:
```json
{
  "imports": {
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2",
    "@std/http": "jsr:@std/http@1"
  }
}
```

## 3. CORS Preflight & Response Handling
Every edge entry point must handle CORS OPTIONS preflight:
```typescript
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// CORS preflight must be the first check in request handlers
if (req.method === "OPTIONS") {
  return new Response("ok", { headers: corsHeaders });
}
```
Missing `OPTIONS` handler causes silent browser-side CORS failures.
