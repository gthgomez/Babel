<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Test Enforcement (v1.0)

**Category:** Mobile
**Status:** Active
**Load order:** Load **last** among all Android testing skills. Enforcement must know which test surfaces were selected before it can enforce them. Loading this file before the leaf skills can cause it to enforce against surfaces that were not selected.
**Load after:** `skill_android_testing_strategy` and whichever of `skill_android_unit_testing`, `skill_android_instrumented_testing`, `skill_android_screenshot_testing` apply to the task.
**Takes precedence when:** A behavior-changing plan is complete and requires a verification block before it can be marked done.

**Pairs with:** `domain_android_kotlin`, `skill_android_testing_strategy`, `skill_android_unit_testing`, `skill_android_instrumented_testing`, `skill_android_screenshot_testing`
**Activation:** Load for any task that changes behavior, ViewModel state, UI branching, billing,
platform APIs, or CI expectations.

---

## Purpose

Having test skills is not enough. Babel must know when tests are merge blockers.

This skill converts testing from "nice to have" into explicit release discipline for the Android
lane.

---

## Step 1 — REQUIRED TEST MATRIX

| Change type | Required tests | Merge blocker? |
|-------------|----------------|----------------|
| Processing logic, constraint math, result mapping | Unit tests in `src/test/` | Yes |
| ViewModel reducer, state transition, entitlement state | Turbine-based ViewModel tests in `src/test/` | Yes |
| New UI branch, conditional layout, theme-sensitive state | Screenshot tests | Yes |
| Platform API integration (`ContentResolver`, picker, WorkManager, permissions) | Instrumented or Robolectric/platform-safe test | Yes |
| Billing flow change | ViewModel tests + instrumented or integration-safe billing test | Yes |
| Pure copy change with no behavior change | No mandatory new tests | No |

If the task changes behavior and no required test is added or updated, the task is incomplete.

---

## Step 2 — ENFORCEMENT RULES

### Processing logic

Any new or changed processing logic must have unit coverage.

This includes:
- size/dimension normalization
- EXIF or file-result decision logic
- transformation result mapping
- failure classification

Manual QA is not a substitute.

### ViewModel changes

Any change to a ViewModel's state transition logic must add or update Turbine tests.

Required proof:
- initial state
- triggering event
- expected emissions in order
- final state or effect

Reading only `uiState.value` after the fact is not sufficient.

### UI branches

Any new UI branch that changes what the user sees must have screenshot coverage.

Examples:
- locked vs unlocked paywall
- empty vs loaded result
- error state
- light vs dark rendering where visibility matters

If the branch matters enough to ship, it matters enough to capture visually.

---

## Step 3 — CI EXPECTATIONS

The Android lane must treat these as the default CI contract:

```text
./gradlew test
./gradlew verifyRoborazziDebug     # when screenshot tests exist or UI branches changed
./gradlew connectedDebugAndroidTest # when platform API or instrumented coverage changed
```

At minimum:
- unit tests must pass on every relevant behavior change
- screenshot verification must run for UI-branch changes
- platform/instrumented coverage must run when Android framework behavior is part of the change

If a verification step is not run, the final report must say exactly why.

---

## Step 4 — FAILURE CONDITIONS

Reject or mark incomplete when any of the following are true:

1. behavior changed but no matching test was added or updated
2. ViewModel logic changed without Turbine coverage
3. UI branching changed without screenshot verification
4. platform API behavior changed without a device, Robolectric, or framework-aware test
5. CI or local verification was skipped without explicit reason

This skill is an enforcement layer. These are blockers, not suggestions.

---

## Step 5 — ACCEPTABLE EXCEPTIONS

Only these cases can omit new tests:
- copy-only text changes with no branch or layout impact
- comment-only changes
- refactors proven behavior-preserving by existing coverage and unchanged outputs

Even in those cases, existing tests must still pass if they touch the changed surface.

---

## Step 6 — ANTI-PATTERNS

| Anti-pattern | Why it fails the lane | Required correction |
|--------------|----------------------|---------------------|
| "Manual QA only" for processing logic | Unrepeatable and easy to regress | Add unit tests |
| Snapshotting only `uiState.value` after a ViewModel action | Misses emission order and transient states | Use Turbine |
| Recording new screenshot goldens in CI | Hides regressions instead of detecting them | Record locally, verify in CI |
| Treating platform API code as unit-testable without Android support | Produces false confidence or untestable mocks | Use instrumented or Robolectric-safe path |
| Skipping tests because code "already existed" | Behavior drift can still be introduced | Update tests for the changed path |

---

## Step 7 — PLAN OUTPUT

Every Android behavior-changing plan must include:

```text
TEST ENFORCEMENT

Behavior surfaces changed: [list]
Required test classes: [list]
Why each test is mandatory: [one line each]
CI commands to run: [list]
Any skipped verification: [none or explicit reason]
```

---

## Hard Rules

1. Processing logic changes require unit tests.
2. ViewModel changes require Turbine tests.
3. UI branch changes require screenshot tests.
4. Platform API changes require framework-aware tests.
5. Work is not complete until the required verification path has run or an explicit blocker is
   documented.
