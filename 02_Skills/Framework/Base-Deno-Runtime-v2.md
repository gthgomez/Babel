<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Base Deno Runtime (v2.0)
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

---

## Boundaries — Do Not Overstep
- This skill provides Babel-specific governance and release conventions. It does not replace official platform documentation or security best-practice guides.
- Version-specific guidance must be verified against current stable releases before use in production plans.

## Failure Behavior of This Skill
- **Referenced policy or process is outdated:** Flag as STALE. Recommend verification against current Babel governance documentation.
- **Guidance conflicts with another governance skill:** Activate `coherence-linter` to detect and resolve.
- **Release/security gate fails:** Halt the release. Do not proceed with a failing gate.

## Strategic Next Move
After every substantial response, end with one strategic next-move question focused on the highest-leverage validation step.

## References
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening governance patterns.
- `skill_standards_currency_audit` (`02_Skills/Governance/Standards-Currency-Audit-v2.md`) — for scheduled re-verification.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting contradictions.

---

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-20.
