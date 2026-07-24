<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Permissions (v1.0)

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
