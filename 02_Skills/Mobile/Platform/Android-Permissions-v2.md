<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Android Permissions (v2.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`, `skill_android_play_store_compliance`
**Activation:** Load for manifest permission changes, runtime permission flows, special access
settings, overlay flows, usage access, or any task that may add a new permission.

---

## Purpose

Permissions are product-scope decisions with policy impact. Wrong permission choices trigger Play
review, user distrust, and unnecessary implementation complexity.

This skill enforces least-privilege Android permission design.

---

## Step 1 — CLASSIFY BEFORE REQUESTING

Every permission must be classified first:

| Type | Examples | Request path |
|------|----------|--------------|
| Normal | `INTERNET`, `VIBRATE` | Manifest only |
| Dangerous | `CAMERA`, `READ_MEDIA_IMAGES` | Runtime prompt via Activity Result APIs |
| Special access | `SYSTEM_ALERT_WINDOW`, `PACKAGE_USAGE_STATS` | System settings screen, not runtime permission dialog |

If a feature can be implemented without a dangerous permission, do not request it.

---

## Step 2 — MODERN RUNTIME PATTERN

Use Activity Result APIs:
- `RequestPermission`
- `RequestMultiplePermissions`

Request permissions from a user-understandable action, not blindly on app launch.

Handle:
- granted
- denied
- denied with rationale
- denied and effectively permanent

`shouldShowRequestPermissionRationale()` informs UX, not entitlement.

---

## Step 3 — SPECIAL ACCESS RULES

These are not normal permissions:
- `SYSTEM_ALERT_WINDOW`
- `PACKAGE_USAGE_STATS`

Rules:
- route the user to the correct settings screen
- verify status after return
- do not pretend a runtime launcher can grant them

If the app needs special access, the plan must explain why a narrower standard permission is
insufficient.

---

## Step 4 — COMMON FAILURE CASES

| Failure | Why it happens | Prevention |
|---------|----------------|-----------|
| Requesting broad storage permission for photo pick | legacy implementation habit | use Photo Picker or SAF instead |
| Asking on first launch with no context | bad UX and lower grant rate | request from an action tied to the feature |
| Treating special access like a dangerous permission | wrong API model | send user to settings and re-check status |
| Ignoring permanent denial path | app gets stuck or loops prompts | provide fallback UX and settings path |
| Adding permission "just in case" | overreach and policy risk | require explicit feature justification |

---

## Step 5 — POLICY / COMPLIANCE NOTES

- Least privilege is the default.
- Dangerous permissions require clearer justification and often store scrutiny.
- Do not add media or storage permissions if Photo Picker or SAF already solves the feature.
- Overlay and usage-access permissions are high-risk and must be justified at both implementation
  and product levels.

---

## Hard Rules

1. Never add a permission without naming the exact feature that requires it.
2. Never request a broad permission when a narrower modern API exists.
3. Never treat special access as a normal runtime permission.
4. Never prompt repeatedly without handling denial and settings fallback correctly.
5. Permission work is incomplete until the user-flow, denial-flow, and compliance impact are all
   accounted for.

---

## Boundaries — Do Not Overstep
- This skill provides Babel-specific Android development conventions. It does not replace official Android developer documentation, Jetpack guides, or platform compatibility definitions.
- Version-specific guidance (target SDK, Compose BOM, AGP versions) must be verified against current Android stable releases before use in production plans.

## Failure Behavior of This Skill
- **Referenced Android API or library version is outdated:** Flag as STALE. Recommend web-search verification against current Android developer documentation.
- **Platform-specific guidance conflicts with another skill:** Activate `coherence-linter` to detect and resolve.
- **Testing/UI pattern fails on a specific device or API level:** Flag as DEVICE_SPECIFIC. Verify against AndroidX compatibility tables.

## Strategic Next Move
After every substantial response, end with one strategic next-move question focused on the highest-leverage validation step (run the test, verify the API level, check the permission).

## References
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening Android patterns.
- `skill_standards_currency_audit` (`02_Skills/Governance/Standards-Currency-Audit-v2.md`) — for scheduled re-verification of Android API and library versions.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting contradictions across Android skills.

---

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-20 per Phase 4 Tier 3 Migration — Block 1 (Android Extended).
