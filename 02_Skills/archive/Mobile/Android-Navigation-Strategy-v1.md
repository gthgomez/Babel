<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Navigation Strategy (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`, `skill_android_app_classification`, `skill_android_state_management`
**Activation:** Load for any task that introduces a screen, changes a flow, restructures back
behavior, adds deep links, or proposes a navigation library.

---

## Purpose

Navigation is an architecture decision, not a UI convenience. Wrong navigation choices produce
silent architectural drift: large objects pushed through Bundles, ViewModels split just to satisfy
route strings, or a NavHost added to a utility app that only needed screen state.

This skill defines the three allowed navigation models and the decision rules that select them.

---

## Step 1 — SELECT THE NAVIGATION MODEL

Choose exactly one model based on the app classification.

| App classification | Default model | Escalation trigger |
|-------------------|---------------|--------------------|
| `utility_stateless` | `local_state_navigation` | Only escalate if deep links or non-linear back stack are truly required |
| `utility_stateful` | `local_state_navigation` | Escalate if flows become deep-linkable or cross-feature |
| `content_data_driven` | `navigation_compose_typed` | Escalate to Navigation 3 only if explicit back-stack ownership is beneficial |
| `multi_feature` | `navigation_compose_typed` or `navigation_3_back_stack` | Navigation 3 when feature-owned back stacks are a real requirement |

If the app classification is unknown, stop and load `skill_android_app_classification` first.

---

## Step 2 — MODEL DEFINITIONS

### `local_state_navigation`

Use for utility apps with a small number of screens and one shared ViewModel.

Pattern:
- screen lives in `AppUiState`
- root composable switches on `state.screen`
- ViewModel owns screen transitions
- `BackHandler` maps system back to ViewModel event handling

```kotlin
data class AppUiState(
    val screen: AppScreen = AppScreen.Home,
    val result: ProcessedImage? = null
)

enum class AppScreen {
    Home,
    Preview,
    Result
}

when (state.screen) {
    AppScreen.Home -> HomeScreen(...)
    AppScreen.Preview -> PreviewScreen(...)
    AppScreen.Result -> ResultScreen(...)
}
```

Use this model when:
- the app has a linear or shallow flow
- processed results already live in ViewModel state
- deep links are absent or trivial
- the back stack can be represented by state transitions

### `navigation_compose_typed`

Use for standard apps that need typed destinations, deep links, or more formal route ownership.

Pattern:
- use Navigation Compose with typed, serializable route keys
- pass only small scalar identifiers in routes
- ViewModel still owns domain state and business decisions
- destination entry loads IDs, never large objects

Allowed payloads:
- database ID
- stable string key
- enum-like route discriminator

Forbidden payloads:
- `Bitmap`
- `ByteArray`
- processed document bytes
- domain aggregate graphs

### `navigation_3_back_stack`

Use only when explicit back-stack ownership is itself a product requirement.

Pattern:
- app owns a typed back-stack list
- features can model navigation as stateful stack mutation
- back-stack policy is explicit and testable
- use when multiple feature areas need precise, owned history semantics

Do not adopt this because it is newer. Adopt it only when explicit stack ownership is the
simplest correct expression of the app's behavior.

---

## Step 3 — ENFORCEMENT RULES

1. Navigation is a state transition. It is not a transport mechanism for large data.
2. ViewModel owns navigation state. Composables emit intents; they do not decide routes.
3. Large objects never cross navigation boundaries. Hold them in ViewModel state or reload
   them from a stable identifier.
4. A utility app must not introduce `NavHost` without a classification-backed reason.
5. Deep links are an app requirement, not a reason to over-engineer unrelated flows.

---

## Step 4 — VIEWMODEL OWNERSHIP RULES

The ViewModel owns:
- current screen or current back-stack state
- transition rules
- guards for blocked transitions
- loading or restoration triggered by destination IDs

The UI owns:
- rendering the active screen
- emitting events such as `onBackClick()` or `onResultConfirmed()`

The UI must not:
- push route strings directly
- mutate back-stack state directly
- serialize domain objects to satisfy navigation

---

## Step 5 — ANTI-PATTERNS

| Anti-pattern | Why it is wrong | Correct pattern |
|--------------|-----------------|-----------------|
| Adding `NavHost` to a `utility_stateless` app by default | Increases dependency surface and route complexity for no product gain | Keep screen state in `AppUiState` |
| Passing `ByteArray` or `Bitmap` via route args | Exceeds Bundle/Binder limits and couples transport to UI | Keep data in ViewModel state or load by ID |
| Calling `navController.navigate()` from business logic layers | Leaks UI framework concerns into application logic | Emit ViewModel event and update navigation state there |
| Letting composables decide back behavior ad hoc | Produces inconsistent back-stack semantics | Centralize back handling in ViewModel + `BackHandler` |
| Reconstructing full domain objects from route JSON | Creates serialization drift and versioning risk | Pass stable identifiers only |

---

## Step 6 — REQUIRED OUTPUT FOR NAVIGATION TASKS

Every navigation-related plan must state:

```text
NAVIGATION DECISION

App classification: [utility_stateless | utility_stateful | content_data_driven | multi_feature]
Selected model: [local_state_navigation | navigation_compose_typed | navigation_3_back_stack]
Why this model is correct: [1-2 sentences]
Why the next more complex model is not yet justified: [1 sentence]
Route payload policy: [IDs only | no route payloads | explicit typed keys]
ViewModel ownership: [which ViewModel owns the transition state]
```

---

## Hard Rules

1. Never pass large objects through routes.
2. Never let a composable own business navigation state.
3. Never introduce Navigation Compose or Navigation 3 into a utility app without a written
   classification-backed reason.
4. Never use navigation arguments as a substitute for proper state ownership.
5. Always make back behavior explicit and testable.
