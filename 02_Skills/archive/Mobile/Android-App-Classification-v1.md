<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android App Classification (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Activation:** Load as the FIRST skill for any new Android app project, any refactoring task that
touches architecture, or any session where a model might default to Hilt, Room, or NavHost.
This skill is the gate that prevents over-engineering before it starts.

**Purpose in the lane:** Most Android tutorials and training corpora default to enterprise-grade
patterns (Hilt, Room, Navigation Compose, multi-module). These patterns are correct for large
apps. For utility apps — where correctness, Play Store compliance, and zero-bloat matter most —
they add accidental complexity that increases attack surface and maintenance cost without
improving outcomes. Classify first. Architect second.

---

## Step 1 — APP TYPE CLASSIFICATION MATRIX

Before writing a single line of architecture code, classify the app using this table.

| App Type | Definition | Examples in this monorepo |
|----------|-----------|--------------------------|
| `utility_stateless` | Single-purpose tool, no persistence, no user accounts. Processes input -> emits output. | example_app_one, example_app_three, example_app_two |
| `utility_stateful` | Single-purpose tool with user preferences or history stored locally. No server sync. | example_app_four (settings only), a timer app |
| `content_data_driven` | Browses or displays a corpus of data; persistence required; may have search and filters. | Recipe app, news reader, catalog browser |
| `multi_feature` | Multiple distinct feature areas; separate navigation graphs; team ownership boundaries. | Google Keep, Spotify, large SaaS mobile client |

### Classification Questions

Answer these before assigning a type:

1. Does the app persist **user-generated data** between sessions? (not just prefs)
   → Yes + complex schema → `content_data_driven` or `multi_feature`
2. Does the app have **2+ distinct feature areas** that a different team might own?
   → Yes → `multi_feature`
3. Does the app process input and emit output with **no data that outlives the session**?
   → Yes → `utility_stateless`
4. Does it need to **remember settings or history** but not complex relational data?
   → Yes → `utility_stateful`

---

## Step 2 — ARCHITECTURE DECISION TABLE

Each app type maps to an exact architecture. Do not deviate without a documented reason.

| Decision Point | utility_stateless | utility_stateful | content_data_driven | multi_feature |
|----------------|------------------|-----------------|----------------|---------------|
| **Dependency injection** | Manual constructor injection | Manual constructor injection | Manual or Hilt | Hilt |
| **Navigation** | Enum state in `AppUiState` | Enum state in `AppUiState` | Navigation Compose (typed) | Navigation Compose (typed) or Navigation 3 |
| **Persistence** | None | `SharedPreferences` or `DataStore` | Room | Room + multi-module |
| **Modularization** | Single `:app` module | Single `:app` module | `:app` + optional `:data` | `:app` + feature modules |
| **ViewModel** | 1 shared `MainViewModel` | 1 shared `MainViewModel` | Per-screen ViewModels | Per-feature ViewModels |
| **State model** | Single `AppUiState` data class | Single `AppUiState` data class | Screen-scoped states | Feature-scoped states |
| **Background work** | Coroutines in ViewModel scope | WorkManager if periodic | WorkManager | WorkManager + per-feature |
| **Testing surface** | `test/` (unit + ViewModel) | `test/` + `androidTest/` (prefs) | All three suites | All three suites + UI |

### This Monorepo (all apps = `utility_stateless`)

```
All apps in example_mobile_suite classify as utility_stateless.
The correct architecture is:
  - Manual constructor injection — NO Hilt, Koin, or Dagger
  - Enum navigation in AppUiState — NO NavHost, NavController
  - No persistence layer — NO Room, no SQLite, no DataStore beyond example_app_four prefs
  - One MainViewModel — NOT one ViewModel per screen
  - collectAsStateWithLifecycle() — NOT collectAsState()
```

Any plan that proposes Hilt, Room, or NavHost for a utility_stateless app must be flagged
and rejected unless the app type has been reclassified with documented justification.

---

## Step 3 — UPGRADE TRIGGER RULES

These are the only conditions under which you may escalate the architecture:

### Manual DI → Hilt

**Trigger:** The dependency graph has 3+ levels of transitive dependencies OR 5+ injectable
components across 3+ screens OR a team of 3+ developers working on the same module.

**NOT a trigger:** "Hilt is cleaner" or "it's the official recommendation." Official
recommendations are for general Android development. This skill governs utility apps.

### Enum Navigation → Navigation Compose

**Trigger:** The app has 4+ distinct screens with back-stack management requirements, deep link
support, or type-safe argument passing between screens with non-trivial argument types.

**NOT a trigger:** "Navigation Compose is the modern approach." Enum navigation is correct for
simple, linear flows in utility apps. It has zero dependencies, zero boilerplate, and is trivial
to test.

### No Persistence → Room

**Trigger:** The app stores user-generated data with relationships, needs querying, or syncs
to a backend. User preferences alone never justify Room.

**NOT a trigger:** Caching a single processed result. Hold results in `AppUiState` in the
ViewModel — they live in memory for the session and do not need persistence.

### Single ViewModel → Per-Screen ViewModels

**Trigger:** The shared ViewModel exceeds ~300 lines of meaningful logic OR screens have
state that is completely independent (different data sources, no shared actions).

**NOT a trigger:** "It's cleaner to separate them." Premature ViewModel splitting creates
shared-state coordination bugs. Keep it simple until the complexity justifies the split.

---

## Step 4 — ANTI-PATTERN ENFORCEMENT TABLE

When reviewing AI-generated code or a peer's plan, flag any of these immediately:

| Anti-Pattern | Why It's Wrong for Utility Apps | Correct Alternative |
|-------------|--------------------------------|---------------------|
| `@HiltViewModel` + `@Inject` on a utility_stateless app | Adds 100+ generated classes, kapt/KSP build cost, no benefit | Manual `MainViewModel(engine, billing)` in `MainActivity` |
| `NavHost { composable("home") { } }` | String routes are fragile; large import graph; route typos are runtime crashes | `when(state.screen) { AppScreen.Home -> HomeScreen(...) }` |
| Room `@Database` annotation | Processing results held in RAM survive the session; DB adds write latency and migration risk | Keep result in `AppUiState.result` in ViewModel |
| One `ViewModel` per screen for simple flows | Creates action-routing complexity; state split across 3 VMs for a 3-screen app | Single `MainViewModel` with `AppUiState` data class |
| `rememberNavController()` outside `NavHost` | Leaked host; no valid route to pop to | Remove `NavHost`; use enum state |
| `savedStateHandle.get<T>()` for large objects | `SavedStateHandle` is backed by Bundle; `ByteArray` exceeds Binder limit → crash | Hold processed images in `AppUiState`, never in args |
| `inject()` field injection in `Fragment` | `Fragment` is wrong layer for this stack; injection timing bugs | Use `Activity`; wire deps manually |

---

## Step 5 — CLASSIFICATION OUTPUT FORMAT

When classifying an app at session start, output this block:

```
APP CLASSIFICATION

App: [app name]
Type: [utility_stateless | utility_stateful | content_data_driven | multi_feature]
Justification: [1–2 sentences citing which classification questions drove the answer]

Architecture decisions:
- DI: [Manual constructor injection | Hilt]
- Navigation: [Enum state | Navigation Compose | Navigation 3]
- Persistence: [None | SharedPreferences/DataStore | Room]
- Modularization: [Single :app | feature modules]
- ViewModel scope: [Single MainViewModel | per-screen | per-feature]

Upgrade triggers not met: [list what would need to be true to escalate each decision]
```

---

## Hard Rules

1. Never accept Hilt, Room, or NavHost in a `utility_stateless` app without a written
   reclassification. "It scales better" is not a reclassification reason.
2. Never split a single ViewModel into per-screen ViewModels unless the trigger condition in
   Step 3 is met. Premature splits are a source of bugs, not clarity.
3. Never add a persistence layer to cache results that already live in ViewModel state.
   `AppUiState` is the cache. It lives for the session. That is sufficient.
4. Never treat "official Android documentation defaults" as architecture requirements.
   Official docs target the median Android project, not a minimal utility app. This skill
   defines what is correct for this monorepo's app type.
5. Always classify before proposing architecture. A proposal without a classification is
   a proposal without a foundation.
