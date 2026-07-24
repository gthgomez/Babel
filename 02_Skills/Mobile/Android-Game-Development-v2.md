<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Android Game Development (v2.0)

**Category:** Mobile / Game
**Status:** Active
**Last Verified:** 2026-04-29
**Activation:** Load for native Android game loops, GameActivity, AGDK, OpenGL/Vulkan
renderers, controller input, low-latency game audio, game memory pressure, or Android
game performance work.

---

## Purpose

Android games have different failure modes from utility apps: frame pacing, render-loop
synchronization, controller input, native memory pressure, and release-mode device behavior.
This skill keeps game-specific Android work separate from general Compose app guidance.

Use `skill_android_tv_game_ux` with this skill for Fire TV / Android TV / Leanback game
surfaces. Do not load this skill for a normal Compose app just because the app has playful UI.

---

## Current Standards Basis

- Android GameActivity / AGDK: `https://developer.android.com/games/agdk/game-activity`
- Android Frame Pacing / Swappy: `https://developer.android.com/games/sdk/frame-pacing`
- Android game controllers: `https://developer.android.com/games/sdk/game-controller/overview`
- Memory Advice API status: `https://developer.android.com/games/sdk/memory-advice/overview`

---

## Step 1 - Classify The Game Surface

Choose the smallest correct implementation lane:

| Surface | Preferred lane |
|---------|----------------|
| Kotlin/Compose card, board, quiz, or party game | Standard Android app architecture plus game UX skills |
| Custom OpenGL/Vulkan renderer | AGDK / GameActivity lane |
| Native C/C++ intensive game | GameActivity lane |
| Engine-exported game | Use the engine export skill, not this native lane, unless editing Android glue code |

Do not introduce GameActivity, NDK, or a busy render loop into a UI-driven game that can remain
a normal Android app.

---

## Step 2 - Lifecycle And Render Loop

For native or renderer-heavy games:

1. Prefer `GameActivity` for new C/C++ intensive Android games instead of `NativeActivity`.
2. Keep lifecycle commands, input events, and render-thread state transitions explicit.
3. Use Android Frame Pacing / Swappy for OpenGL ES or Vulkan renderers where frame timing
   is controlled by the game.
4. Never render as fast as possible; target display-aware pacing and avoid buffer stuffing.
5. Treat debug frame timing as non-authoritative. Verify release-like builds on hardware.

For Compose-driven games:

1. Keep game state in a ViewModel or explicit game controller object.
2. Use Compose only as the render shell for UI state.
3. Avoid ad hoc infinite loops in composables. Use timers, coroutines, or animation APIs with
   lifecycle-aware cancellation.

---

## Step 3 - Input And Controllers

1. Define input actions before implementation: primary action, secondary action, back/cancel,
   directional navigation, pause/menu, and optional shoulder/trigger actions.
2. Support keyboard, D-pad, gamepad, and touch only where the target device requires them.
3. For Kotlin/Java Android games, handle common controller actions with native Android APIs.
4. For C++ GameActivity games, use the Game Controller Library when advanced controller layout,
   haptics, or labels matter.
5. Always test controller support on physical hardware when the release target includes TV,
   tablets with controllers, or Google Play Games on PC.

---

## Step 4 - Memory And Assets

1. Budget native heap, graphics memory, decoded textures, and audio buffers separately.
2. Use Android Studio profilers and Android Vitals data for memory regressions.
3. Respond to memory pressure through asset-quality reduction, cache trimming, and scene unload.
4. Treat the Memory Advice API as legacy/deprecated unless the project already depends on it.
   Do not add it to new code without fresh approval and a replacement analysis.
5. Avoid loading all levels, atlases, or audio banks at startup.

---

## Step 5 - Audio

1. For low-latency native game audio, prefer Oboe or the engine's Android audio backend.
2. Separate music, SFX, UI, voice, and master controls in the app or engine abstraction.
3. Pause, duck, or release audio according to Android lifecycle events.
4. Do not block the render thread on audio file decode or streaming setup.

---

## Verification

For Android game work, report:

```text
ANDROID GAME VERIFICATION
Surface lane: [Compose app | GameActivity/native | engine export | mixed]
Input tested: [touch | keyboard | D-pad | controller | skipped + reason]
Frame pacing: [Swappy/engine pacing/Compose animation/no custom renderer]
Memory evidence: [profiler/vitals/manual smoke/skipped + reason]
Release-like build: [command or skipped + reason]
Device coverage: [hardware/emulator/none + reason]
```

---

## Hard Rules

1. Do not add GameActivity or native render-loop complexity to UI-driven games without a clear
   renderer requirement.
2. Do not claim controller support without testing controller navigation and action mapping.
3. Do not recommend new Memory Advice API integration as a default; current docs mark it
   deprecated.
4. Do not make performance claims from debug-only behavior.
5. Do not block first frame on asset banks, large texture decode, billing setup, or network work.

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

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-20.
