<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
-->

# Skill: Android Navigation Strategy (v2.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `skill_android_state_management`, `skill_jetpack_compose`
**Activation:** Load when deciding navigation architecture, adding deep links, or reviewing route payloads.

**Supersedes:** v1 archived at `archive/02_Skills/Mobile/Android-Navigation-Strategy-v1.md` (2026-05-21).

## Purpose

Choose the minimal navigation solution that survives process death and avoids large route payloads.

## Decision Rules

1. **Screen-enum local state**: Use for <=5 screens, no deep links, single module. Store screen in ViewModel with `rememberSaveable`.
2. **Navigation Compose**: Use when deep links, nested graphs, or multi-module navigation required. Navigation Compose supports type safety via Kotlin serialization.
3. **Navigation 3**: Stable as of `androidx.navigation3` `1.1.1`. Use only when you need state-driven back stack ownership for adaptive pane navigation, or when Navigation 3's scene/back-stack model is the simplest correct fit. Re-check latest alpha APIs before adopting `1.2.0-alpha*` behavior, especially predictive back.

## Version Baseline [OFFICIAL]

- Navigation Compose stable baseline: `androidx.navigation:navigation-compose:2.9.8+`.
- Type-safe Navigation Compose routes require Kotlin serialization and were introduced in Navigation `2.8.0+`.
- Navigation 3 stable baseline: `androidx.navigation3:navigation3-runtime:1.1.1+` and `androidx.navigation3:navigation3-ui:1.1.1+`.
- Navigation 3 full app setups may also require `lifecycle-viewmodel-navigation3`, `adaptive-navigation3`, Kotlin serialization, and compileSdk 36+ depending on feature use.

## Typed Destinations [OFFICIAL]

Define routes as `@Serializable` objects or data classes. Navigate with `navController.navigate(Profile(id))` and retrieve with `backStackEntry.toRoute<Profile>()`.

## Payload Policy

- Pass IDs or primitives only. Never pass `ByteArray`, `Bitmap`, or domain aggregates in routes.
- Load full objects in destination ViewModel using ID from `SavedStateHandle`.
- Hold large results in ViewModel scoped to navigation graph.

## Process Death

- Store navigable state in `SavedStateHandle`. ViewModel must restore from handle on recreation.
- For list-detail scaffolds, ensure navigator contentKey is Parcelable.

## Back Behavior

- For adaptive scaffolds, choose explicit back behavior. Test system back, predictive back, and Up navigation on compact and expanded widths.
- For Navigation 3 alpha versions, verify predictive back behavior against the exact artifact version before making the skill recommendation implementation-specific.

## Hard Rules

1. Never use string interpolation for routes.
2. Never read NavController in previewable UI; inject callbacks.
3. Never store business truth in navigation arguments.
4. Never introduce NavHost without documented deep link or module requirement.
