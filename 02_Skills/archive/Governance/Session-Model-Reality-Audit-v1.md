<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Session Model Reality Audit (v1.0)
**Category:** Governance
**Status:** Active
**Pairs with:** `skill_evidence_gathering`, `skill_in_app_truth_sweep`, `skill_supabase_rls_drift_audit`, `skill_untrusted_input_guard`
**Activation:** Load when a system makes claims about auth/session security and you need to verify the real session model. Typical triggers: “HttpOnly cookies”, “JWT rotation”, “logout invalidates sessions”, “refresh token security”, “cookie vs localStorage”, “15-minute JWT”, “cookie-based auth”, or “is our session model actually secure?”.

---

## Purpose

Use this skill to compare claimed session security against actual runtime behavior.

It is for systems where:

1. docs/comments say one thing
2. browser behavior says another
3. the auth provider hides critical details
4. the release decision depends on what is truly enforced

---

## Step 1 — MAP THE SESSION MODEL

Identify:

1. where login happens
2. where tokens are created
3. where access tokens are stored
4. where refresh tokens are stored
5. how protected API requests are authenticated
6. how logout is implemented
7. how password reset and email verification affect sessions

Minimum evidence targets:

- browser auth client
- server auth helper
- proxy/middleware
- protected API client
- auth forms/routes
- provider config

---

## Step 2 — TRACE CLAIMS VS REALITY

Build a claim ledger with:

1. claimed control
2. source of claim
3. effective implementation
4. verdict

Mandatory claims to verify:

1. `HttpOnly`
2. `Secure`
3. `SameSite`
4. access-token expiry
5. refresh-token rotation
6. logout invalidation
7. email verification requirement
8. account lockout or equivalent abuse control

Do not trust comments, README text, or framework defaults without checking the effective library/runtime code.

---

## Step 3 — CHECK THE BROWSER AND SERVER BOUNDARY

For browser-managed auth, answer:

1. Can JavaScript read the session cookie or token?
2. Is the cookie set by the browser or only by the server?
3. Are access tokens forwarded manually as bearer tokens?
4. Does the app rely on `getSession()` or a validated server-side identity check?

Hard rule:

If the browser can write or read the cookie, it is not `HttpOnly`, regardless of what comments say.

---

## Step 4 — CHECK ROTATION, REVOCATION, AND RESET SEMANTICS

For refresh/session behavior, verify:

1. token expiry target
2. refresh token rotation enabled/disabled
3. reuse interval or replay window
4. whether logout revokes server-side session state
5. whether password reset invalidates prior sessions
6. whether verification/reset tokens are single-use and time-bound

If the repo cannot prove a provider-managed guarantee, mark it `NOT VERIFIED`.

---

## Step 5 — CHECK UX LEAKS AROUND AUTH

Inspect signup, login, reset, and verification flows for:

1. account existence leaks
2. verification-state leaks
3. inconsistent statuses
4. raw provider error propagation

Treat auth UX leakage as part of session/auth security, not just copy quality.

---

## Output Contract

Summarize with:

1. `Session architecture`
2. `Actual storage strategy`
3. `Claim / reality mismatches`
4. `Provider-managed but not provable`
5. `Exploitable auth/session weaknesses`
6. `Minimal fix path`

Use verdicts:

- `IMPLEMENTED CORRECTLY`
- `PARTIALLY IMPLEMENTED`
- `MISIMPLEMENTED / INSECURE`
- `NOT IMPLEMENTED`
- `NOT VERIFIED`

---

## Hard Rules

1. Never call a browser-managed cookie `HttpOnly`.
2. Never mark provider behavior as implemented unless it is repo-provable or live-verified.
3. Treat comment/runtime contradictions as security debt.
4. If the public security story is stronger than the real session model, call it out explicitly.
5. Prefer `NOT VERIFIED` over assuming the provider is doing the right thing.
