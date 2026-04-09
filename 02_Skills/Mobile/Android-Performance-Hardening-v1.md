<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Performance Hardening (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`, `skill_jetpack_compose`
**Activation:** Load for store-facing release work, startup-heavy features, scrolling/media screens,
paid apps, benchmark tasks, or any session where performance complaints are part of the problem.

---

## Purpose

Correct apps can still feel broken if startup is slow, scrolling janks, or hot paths recompose
too often. This skill defines when Android performance work is required and which tools are
appropriate.

---

## Step 1 — WHEN PERFORMANCE HARDENING IS REQUIRED

Performance hardening is **required**, not optional, when any of the following is true:
- the app is shipping to a store
- the app is paid or monetized
- cold start is visibly slow on mid-range hardware
- the app renders long lists, media previews, or expensive results
- startup does significant dependency initialization or state restoration

Performance hardening is optional for:
- throwaway prototypes
- internal tooling not intended for release
- narrow code changes proven not to touch startup, scrolling, or hot rendering paths

---

## Step 2 — BASELINE PROFILES

Use Baseline Profiles when the app is store-facing or startup-sensitive.

What they do:
- precompile critical code paths ahead of first real use
- improve startup and first-interaction performance
- reduce JIT warm-up pain for real users

Baseline Profiles are required for:
- release-bound Android apps in this lane
- paid or monetized apps with user-facing startup
- apps with heavy startup setup, billing initialization, or complex Compose trees

Do not skip them because the app is "small." Small utility apps are especially sensitive to
perceived startup lag because users expect instant utility.

---

## Step 3 — MACROBENCHMARK

Use Macrobenchmark when:
- startup time needs measurement
- scrolling or interaction smoothness is in question
- you need evidence before or after a performance change

Macrobenchmark is the measurement tool.
Baseline Profiles are the optimization artifact.
Do not confuse the two.

Use Macrobenchmark to answer:
- cold start cost
- warm start cost
- frame timing during important flows
- regression impact after architectural or UI changes

---

## Step 4 — STARTUP RULES

Startup path rules:

1. `Application.onCreate()` must stay minimal.
2. Do not eagerly initialize work that can wait until first use.
3. Billing, analytics, or expensive processing setup must not block first frame if deferred init
   is possible.
4. Large file or image scans must never run on the main thread during startup.
5. Compose root rendering must not depend on synchronous heavy work.

Use lazy initialization, background precomputation, and explicit user-triggered loading where
appropriate.

---

## Step 5 — COMPOSE PERFORMANCE RULES

For Compose-heavy surfaces:
- avoid expensive computations directly in composition
- keep state reads as local as possible
- use stable models for hot paths
- use item keys in lazy lists
- investigate unstable parameters with compiler reports when recomposition is suspicious

Performance work is required when:
- a list visibly janks
- a hot screen recomposes broad subtrees for small changes
- UI work is bound to changing state at the wrong level

---

## Step 6 — DECISION MATRIX

| Situation | Required tool or action |
|-----------|-------------------------|
| Store release of a monetized app | Baseline Profiles required |
| Startup complaint with no numbers | Add Macrobenchmark |
| Janky scrolling list | Measure + inspect recomposition and lazy list keys |
| Large startup initialization | Defer or lazily initialize non-critical work |
| Small bug fix with no startup/UI impact | Performance work optional |

---

## Step 7 — ANTI-PATTERNS

| Anti-pattern | Why it is wrong | Required correction |
|--------------|-----------------|---------------------|
| Skipping baseline profiles for a release because the app is "simple" | Users still experience startup cost | Add release-grade baseline profile generation |
| Measuring performance by feel alone | No repeatable evidence | Use Macrobenchmark or equivalent measured path |
| Heavy work in `Application.onCreate()` | Delays first frame | Defer or lazy-init |
| Running expensive transformations in composition | Causes jank and recomposition overhead | Move work to ViewModel or processing layer |
| Declaring performance "fine" without release-mode evidence | Debug behavior is misleading | Measure release-like builds |

---

## Step 8 — PLAN OUTPUT

For any release-bound or performance-sensitive task, include:

```text
PERFORMANCE HARDENING

Why performance work is [required | optional]:
Target surface: [startup | scrolling | interaction | release readiness]
Baseline Profiles: [required | not required and why]
Macrobenchmark: [required | not required and why]
Hot-path risks: [list]
```

---

## Hard Rules

1. Store-facing monetized apps require baseline-profile awareness.
2. Startup-heavy changes must not be accepted without considering deferred initialization.
3. Performance claims require measured evidence when the issue is user-visible.
4. Do not optimize blindly; measure first when the bottleneck is unclear.
5. Do not ship release-facing Android work while treating performance as someone else's problem.
