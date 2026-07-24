<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Background Work (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`, `skill_android_permissions`
**Activation:** Load for WorkManager, foreground service, long-running processing, deferred sync,
boot-start behavior, or any task that needs work to outlive the current screen.

---

## Purpose

Android background work is an execution-contract choice. Wrong choices cause lost jobs, illegal
background launches, or Play policy problems around foreground services and battery use.

---

## Step 1 — CHOOSE THE CORRECT EXECUTION MODEL

| Need | Correct tool |
|------|--------------|
| Deferrable guaranteed work | WorkManager |
| User-visible long-running task | Foreground service with correct type + notification |
| In-screen short task tied to current UI | ViewModel coroutine scope |
| Exact-time alarm semantics | AlarmManager only when exact timing is truly required |

Do not use a foreground service just because work is important. Use it only when the user must
see and understand ongoing work.

---

## Step 2 — WORKMANAGER RULES

Use WorkManager for:
- retryable background uploads or exports
- cleanup jobs
- deferred sync or processing
- work that must survive process death

Rules:
- give important work a unique name when duplication would be harmful
- declare constraints explicitly
- observe or query `WorkInfo` instead of guessing completion
- do not expect sub-15-minute periodic cadence from periodic work

---

## Step 3 — FOREGROUND SERVICE RULES

Use a foreground service only when:
- work is long-running
- the user is actively aware of it
- a visible notification is appropriate

Rules:
- declare the correct foreground service type
- do not start from an illegal background context
- stop the service promptly when the task ends
- do not use FGS as a substitute for normal app architecture

Android 15+ restrictions make sloppy FGS behavior easier to break and harder to justify.

---

## Step 4 — LIFECYCLE-SAFE PATTERNS

1. UI-triggered work tied to the current screen belongs in ViewModel scope until it truly needs
   to outlive that scope.
2. Promote work to WorkManager or FGS only when the lifecycle requirement justifies it.
3. Observe completion through supported APIs; do not rely on implicit process continuity.
4. Cancel obsolete work when the business requirement disappears.

---

## Step 5 — COMMON FAILURE CASES

| Failure | Why it happens | Prevention |
|---------|----------------|-----------|
| Work dies when app leaves screen | used ViewModel scope for durable work | move to WorkManager or FGS as appropriate |
| Duplicate background jobs | no unique work policy | use named work and explicit replacement/keep policy |
| Illegal foreground-service launch | started from background or wrong context | obey launch restrictions and user-visible requirements |
| Battery abuse | FGS or wake behavior used for convenience | use the narrowest correct execution model |
| Missed exact timing | relied on WorkManager for exact alarms | use AlarmManager only when exact timing is genuinely required |

---

## Step 6 — POLICY / COMPLIANCE NOTES

- Foreground services are policy-visible and must be justified.
- Do not retain old background-service habits on modern Android.
- Battery-sensitive behavior must use the narrowest correct API.
- Background execution design is part of release-readiness, not an implementation afterthought.

---

## Hard Rules

1. Use WorkManager for durable deferred work by default.
2. Use a foreground service only when the user-visible contract truly requires it.
3. Do not let background work architecture drift out of convenience.
4. Do not assume Android will keep ad hoc background execution alive.
5. Every background-work design must name why its chosen execution model is necessary.
