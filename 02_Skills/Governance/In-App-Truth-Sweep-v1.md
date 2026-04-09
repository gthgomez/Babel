<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: In-App Truth Sweep (v1.0)
**Category:** Governance
**Status:** Active
**Activation:** Load when user-facing copy across an app must be tightened to match verified product scope after product truth has already been checked. Typical surfaces: marketing pages, auth flows, onboarding, dashboard states, docs hubs, empty states, alerts, analytics labels, pricing FAQs, and support/legal-adjacent product copy.

---

## Purpose

Claim audit tells you what is true.

Outbound redlining tells you how to ship safe sales copy.

This skill handles the middle layer: the app itself.

Use it when the problem is not one bad sentence, but repeated scope drift across many user-facing surfaces inside the product.

Typical drift patterns:
- marketing says `sitewide enforcement` while the product is only API-layer
- onboarding says `every request` when the runtime records per-signal decisions
- dashboard states still use `honored` when explicit decision states now exist
- docs, alerts, and empty states repeat older phrasing after the headline copy was fixed

This skill pairs naturally with `skill_product_reality_audit` and `skill_prompt_runtime_continuity`.

---

## Step 1 — DEFINE THE TRUTH BOUNDARY

Before editing copy, write down:

1. `verified_scope`
   - what the product demonstrably does today
2. `non_claims`
   - what must not be implied
3. `legacy_terms`
   - internal fields, route names, or contracts that still exist
4. `protected_surfaces`
   - legal/contract text that should not be casually rewritten

If those four buckets are unclear, do not start the sweep yet.

---

## Step 2 — CLASSIFY SURFACES BEFORE PATCHING

Group the app surfaces into:

1. `marketing`
   - homepage, pricing, trust sections, product explainer copy
2. `lifecycle`
   - auth, signup, onboarding, empty states, setup flows
3. `operational`
   - dashboard summaries, alerts, analytics, logs, site detail pages
4. `docs`
   - docs hub, reference pages, changelog, security overview
5. `legal_or_contractual`
   - terms, privacy, DPA, contractual acceptance modals

The editing bar is different for each group.

Marketing/lifecycle/operational copy should be swept aggressively.

Legal or contractual copy should be changed only when the wording shift is clearly low-risk and does not alter obligations.

---

## Step 3 — SWEEP PHRASE FAMILIES, NOT JUST FILES

Look for repeated phrase families across the app:

- `runtime enforcement`
- `every request`
- `audit-ready`
- `honored`
- `compliance posture`
- `traffic`
- `request-by-request`

Normalize them with scope-safe replacements that match the real product boundary.

Examples:

- `runtime enforcement` -> `API-layer signal handling` or `decision workflows`
- `every request` -> `each GPC signal` or `each signal request sent to the endpoint`
- `honored` -> explicit decision states when available, or neutral `processed` wording when needed for compatibility
- `audit-ready` -> `decision evidence` unless evidence audit supports the stronger claim

Do not rely on a one-file fix. Sweep the whole phrase family.

---

## Step 4 — PRESERVE COMPATIBILITY WHILE FIXING HUMAN COPY

Separate:

1. internal/runtime contract
   - field names like `honored`
   - route paths like `/docs/enforcement`
   - alert source enums like `runtime`
2. visible product copy
   - labels, headings, helper text, empty states, CTA text

Prefer:
- keep the internal contract stable
- update the user-facing label
- document any intentionally retained legacy term

Only change the underlying contract if the task explicitly includes a contract migration.

---

## Step 5 — HANDLE LEGAL/CONFIGURATION COPY WITH CARE

For legal or contractual surfaces:

- prefer terminology clarifications that reduce overclaiming without changing obligations
- avoid substantive legal rewrites unless the task explicitly includes legal review
- call out any intentionally retained contractual language in the final report
- identify the `canonical_policy_surface` first
  - examples: standalone DPA page, privacy policy, terms page, signed-agreement template
- treat inline modals, banners, setup summaries, and FAQs as `summary_surfaces`
  - summary surfaces must not make stronger promises than the canonical policy surface
  - if they drift upward, align them down to the canonical surface or add a pointer to custom terms
- if an inline surface starts promising breach SLAs, retention guarantees, certifications, or negotiated liability terms, stop and collapse it back to a processing summary unless those terms are already canonical

For user-configurable defaults:

- safe wording upgrades are allowed if they reduce ambiguity
- do not silently rewrite already persisted customer data

---

## Step 6 — VERIFY WITH A RESIDUAL SWEEP

After edits:

1. run targeted text search for the risky phrase families
2. separate remaining matches into:
   - internal-only
   - intentional route/path names
   - intentional legal/contract text
   - still-risky user-facing copy
3. run typecheck/tests for touched UI surfaces

The sweep is not complete until the residual matches are explained.

---

## Recommended Output Shape

1. truth boundary used
2. surfaces swept
3. phrase families normalized
4. intentionally retained terms
5. verification evidence

---

## Hard Rules

1. Never "clean up" a real runtime/schema contract just to make copy nicer.
2. Never rewrite legal obligations casually under the banner of copy cleanup.
3. Never let a visible label claim broader scope than the verified product boundary.
4. When explicit decision states exist, prefer them over vague human-facing `honored` language.
5. A successful sweep ends with a residual search and an explanation of what was intentionally left alone.
