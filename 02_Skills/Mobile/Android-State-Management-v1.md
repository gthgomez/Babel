<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android State Management (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`, `skill_android_navigation_strategy`
**Activation:** Load for any task touching `AppUiState`, a ViewModel, reducer logic, screen state,
cross-layer data flow, or Compose state collection.

---

## Purpose

Most Android drift starts with state ownership mistakes: business logic moves into composables,
mutable state leaks across layers, or route payloads start carrying domain objects because the
ViewModel no longer owns the truth.

This skill enforces one rule above all others:

**ViewModel is the single source of truth for business-facing UI state.**

---

## Step 1 — OWNERSHIP MODEL

| Concern | Owner | Allowed API |
|--------|-------|-------------|
| Durable UI/business state | ViewModel | `StateFlow<UiState>` |
| One-off UI effects | ViewModel | `SharedFlow` / channel-backed effect stream when truly necessary |
| Pure rendering concerns | Composable | parameters + local ephemeral `remember` state |
| Domain/business rules | domain / processing layer, orchestrated by ViewModel | pure functions, suspend functions, repositories, engines |

Composables render state. They do not own business truth.

---

## Step 2 — REQUIRED STATEFLOW PATTERN

Use the private-mutable / public-immutable pattern.

```kotlin
private val _uiState = MutableStateFlow(AppUiState())
val uiState: StateFlow<AppUiState> = _uiState.asStateFlow()

fun onAction(action: UiAction) {
    when (action) {
        is UiAction.StartProcessing -> {
            _uiState.update { it.copy(isProcessing = true) }
        }
    }
}
```

Rules:
- `MutableStateFlow` stays private to the owning ViewModel
- UI collects `StateFlow` only
- state transitions happen through named events and reducer-like updates
- use `update {}` or explicit `.value = value.copy(...)`; do not mutate nested fields in place

For Compose collection:
- use `collectAsStateWithLifecycle()`
- do not use `collectAsState()` for app-facing flows in this lane

---

## Step 3 — UI = PURE RENDER LAYER

Composable responsibilities:
- render the current state
- forward user events
- own only ephemeral UI details such as focus or dropdown expansion

Composable non-responsibilities:
- launching business operations by reading repositories directly
- computing domain results
- holding canonical entitlement or processing state
- deciding architectural navigation state

If a composable needs to "figure something out" from domain data, ask whether that mapping belongs
in the ViewModel instead. The default answer is yes.

---

## Step 4 — DATA FLOW CONTRACT

The allowed flow is:

```text
UI event -> ViewModel intent handler -> domain/processing call -> new UiState -> UI render
```

Not allowed:

```text
UI event -> composable mutates shared state -> repository call from UI -> partial UI workaround
```

Domain objects cross into the UI only when:
- they are already the right render model, or
- the ViewModel immediately maps them into UI-specific shape

Do not pass raw domain aggregates through multiple UI layers if a smaller UI model would do.

---

## Step 5 — CROSS-LAYER RULES

1. Domain layer does not know about Compose or navigation.
2. Processing layer does not mutate UI state directly.
3. ViewModel translates domain outcomes into renderable `UiState`.
4. UI does not send domain objects back downward as transport containers.
5. Large binary or document results stay in ViewModel-owned state, not in navigation payloads.

---

## Step 6 — ANTI-PATTERNS

| Anti-pattern | Why it is wrong | Correct pattern |
|--------------|-----------------|-----------------|
| Business logic inside a composable | Makes behavior lifecycle-fragile and hard to test | Move logic into ViewModel or domain layer |
| Exposing `MutableStateFlow` publicly | Any consumer can mutate canonical state | Expose `StateFlow` only |
| Shared mutable singleton state between screens | Produces hidden coupling and race conditions | Route all durable state through the owning ViewModel |
| Passing full domain objects through routes or bundles | Couples transport to internal models and breaks scalability | Pass IDs or hold state in ViewModel |
| Using `remember` for business-critical flags | State resets on configuration or composition exit | Keep business flags in ViewModel |
| Reading `uiState.value` in UI event handlers to "compute" business logic | Mixes render and state transition concerns | Send event to ViewModel and let it decide |

---

## Step 7 — STATE TASK CHECKLIST

For any ViewModel or `UiState` change, the plan must answer:

```text
STATE OWNERSHIP CHECK

Single source of truth: [which ViewModel owns the changed state]
Public exposure: [StateFlow only / effect stream only]
Composable-local state allowed: [list only ephemeral UI details]
Domain-to-UI mapping point: [where mapping happens]
Cross-layer payload policy: [IDs only / UI model only / no large objects]
```

---

## Hard Rules

1. ViewModel is the single source of truth for business-facing UI state.
2. UI is a render layer, not a business-logic layer.
3. `MutableStateFlow` must never be exposed outside the owning ViewModel.
4. Large domain or binary objects must not be used as ad hoc cross-layer transport.
5. If state must survive beyond a single composition and matters to business behavior, it does
   not belong in `remember`.
