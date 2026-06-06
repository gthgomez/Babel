<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
-->

# Skill: Android Adaptive Layouts (v2.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `skill_jetpack_compose`, `skill_android_state_management`
**Activation:** Load for any task that changes navigation shells, list-detail layouts, supporting panes, or must run on tablets, foldables, desktop windows, or multi-window.

**Supersedes:** v1 archived at `archive/02_Skills/Mobile/Android-Adaptive-Layouts-v1.md` (2026-05-21).

## Purpose

Prevent phone-only layouts by forcing window-size driven decisions using official Material 3 adaptive APIs.

## Version Baseline [OFFICIAL]

Use these dependency baselines unless the target project has stricter pinned versions:
- Stable path: Material 3 Adaptive `1.2.0+`.
- Beta path: Material 3 Adaptive `1.3.0-beta01+`.

For `1.3.0-beta01+`, compute adaptive info with `currentWindowAdaptiveInfoV2()`, which supports Large and Extra-large width classes by default. For stable `1.2.0`, use `currentWindowAdaptiveInfo(supportLargeAndXLargeWidth = true)`. Do not use the older overload on `1.3.0-beta01+` without checking deprecation status.

## Breakpoint Source of Truth [OFFICIAL]

Window size classes are opinionated breakpoints: Compact, Medium, Expanded, Large, Extra-large. Width classes drive most layout decisions.

Values to use:
- Compact width < 600dp
- Medium width 600dp-840dp
- Expanded width 840dp-1200dp
- Large width 1200dp-1600dp
- Extra-large width >= 1600dp

## Core Rules

1. Classify window before choosing shell. Never use device type or `isTablet` boolean.
2. Use `NavigationSuiteScaffold` for primary navigation. It switches between NavigationBar and NavigationRail automatically based on window size.
3. Use canonical scaffolds for content:
   - List-detail: `NavigableListDetailPaneScaffold`
   - Supporting pane: `NavigableSupportingPaneScaffold` (wraps SupportingPaneScaffold and adds navigation)
4. Preserve selection state in the navigator's Parcelable contentKey. Do not store business selection in `remember`.
5. Respect insets. Pass `paddingValues` from Scaffold to content and apply `WindowInsets.safeDrawing`.
6. Constrain form content on expanded widths to a readable max (~840dp) and center; do not stretch inputs edge to edge.
7. For foldables, re-evaluate on posture change; do not place critical controls in hinge area.

## Decision Guide

- Compact: NavigationBar, single pane
- Medium: NavigationRail, consider list-detail
- Expanded and above: NavigationRail or permanent drawer, list-detail or supporting pane visible side-by-side

## Compose Implementation Checks

Preferred on Material 3 Adaptive `1.3.0-beta01+`:

```kotlin
val adaptiveInfo = currentWindowAdaptiveInfoV2()
val windowSizeClass = adaptiveInfo.windowSizeClass
```

Stable Material 3 Adaptive `1.2.0` fallback:

```kotlin
val adaptiveInfo = currentWindowAdaptiveInfo(supportLargeAndXLargeWidth = true)
val windowSizeClass = adaptiveInfo.windowSizeClass
```

```kotlin
NavigationSuiteScaffold(
    navigationSuiteItems = { /* items */ }
) {
    // content receives insets via Scaffold paddingValues
}
```

- Read size class once at top level, pass down as parameter.
- Use `rememberListDetailPaneScaffoldNavigator<T : Parcelable>()` for list-detail.
- Keep ViewModel as single source of truth when shell changes.

## Testing Matrix

Test at minimum: compact phone portrait, compact phone landscape, medium tablet portrait, expanded tablet landscape, large desktop window, foldable folded and unfolded, multi-window 50/50 split.

## Hard Rules

1. Never choose layout based on device model.
2. Never ignore Scaffold `paddingValues`.
3. Never implement custom rail/bar switch when `NavigationSuiteScaffold` suffices.
4. Never move ViewModel state into shell composable to support adaptation.
