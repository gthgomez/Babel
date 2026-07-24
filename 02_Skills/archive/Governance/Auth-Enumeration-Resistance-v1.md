<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Auth Enumeration Resistance (v1.0)
**Category:** Governance
**Status:** Active
**Pairs with:** `skill_untrusted_input_guard`, `skill_evidence_gathering`, `skill_in_app_truth_sweep`, `skill_session_model_reality_audit`
**Activation:** Load when reviewing or fixing signup, login, password reset, unlock, or verification flows for account-discovery leaks. Typical triggers: “user already exists”, “email not confirmed”, “forgot password”, “generic auth errors”, “enumeration”, or “does auth leak whether this email exists?”.

---

## Purpose

Use this skill to eliminate account-discovery signals from auth flows.

The target is simple:

An attacker should not be able to learn whether an email exists, is verified, is locked, or has special auth state based on UI text, API payloads, or status-code differences.

---

## Step 1 — TRACE THE AUTH FLOWS

Inspect:

1. signup
2. login
3. forgot password
4. password reset callback/update
5. email verification
6. account unlock if present

Collect:

1. frontend text shown to the user
2. backend/provider error payload
3. response status
4. logs

---

## Step 2 — BUILD THE ENUMERATION MATRIX

Test or reason through these cases:

1. existing verified email
2. existing unverified email
3. nonexistent email
4. locked or throttled account
5. invalid password

For each flow, ask:

1. Does the message differ?
2. Does the status differ?
3. Does the redirect path differ?
4. Does timing obviously differ?

Any stable difference that reveals account state is a leak.

---

## Step 3 — CLASSIFY THE LEAKS

Classify each leak as:

1. `existence_leak`
2. `verification_state_leak`
3. `lockout_state_leak`
4. `provider_error_leak`
5. `status_code_leak`
6. `timing_leak`

Treat copied provider error strings as suspicious by default.

---

## Step 4 — DESIGN THE SAFE RESPONSE SURFACE

Preferred response posture:

1. signup: generic success or next-step message
2. login: generic invalid credentials or generic sign-in failure
3. forgot password: generic “if the account exists, we sent instructions”
4. verification: generic invalid or expired link

Keep sensitive detail in server logs, not user-facing copy.

Do not erase helpful UX by accident:

If a more specific message is retained, justify why it does not reveal account existence or state.

---

## Step 5 — VERIFY THE NORMALIZATION

After changes:

1. re-run the matrix
2. confirm all user-facing messages converge
3. confirm logs still preserve enough diagnostic detail
4. confirm rate-limit and abuse messages do not leak too much state

---

## Output Contract

Summarize with:

1. `Flow`
2. `Leaking condition`
3. `Observed user-visible difference`
4. `Leak class`
5. `Safe normalized response`
6. `Residual risk`

Use verdicts:

- `RESISTANT`
- `LEAKS STATE`
- `LEAKS EXISTENCE`
- `NOT VERIFIED`

---

## Hard Rules

1. “User already exists” is an existence leak.
2. “Email not confirmed” is a verification-state leak.
3. Raw provider error text is guilty until proven safe.
4. A generic UI plus a revealing status code is still a leak.
5. If timing differences are visible and meaningful, note them even if you cannot fully fix them in this pass.
