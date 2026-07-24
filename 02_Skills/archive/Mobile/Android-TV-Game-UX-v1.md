<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Skill: Android TV Game UX (v1.0)

**Category:** Mobile / Game / TV
**Status:** Active
**Last Verified:** 2026-04-29
**Activation:** Load for Android TV, Fire TV, Leanback, D-pad, gamepad, couch multiplayer,
10-foot UI, TV manifests, TV game controller prompts, or remote-first Android game UX.

---

## Purpose

TV games fail when they quietly assume touch, mouse precision, phone-scale text, or a Menu key
that many remotes do not have. This skill enforces Android TV and Fire TV game UX constraints
for Kotlin/Compose and native Android game surfaces.

Use with `skill_android_game_development` for native game-loop work and with
`skill_jetpack_compose` for Compose UI implementation.

---

## Current Standards Basis

- Android TV app quality: `https://developer.android.com/docs/quality-guidelines/tv-app-quality`
- Android TV focus system: `https://developer.android.com/design/ui/tv/guides/styles/focus-system`
- Android game controllers: `https://developer.android.com/games/sdk/game-controller/overview`

---

## Step 1 - Manifest And Store Eligibility

Verify TV-specific manifest behavior before UI polish:

1. Main TV launch activity declares `ACTION_MAIN` and `CATEGORY_LEANBACK_LAUNCHER`.
2. App provides a TV banner asset.
3. `android.hardware.touchscreen` is declared `required=false` when touch is not required.
4. Game-controller requirements are declared only when a controller is truly required.
5. TV build supports commonly used TV devices and store requirements for SDK, 64-bit, and
   current native page-size deadlines when native code is present.

Do not call an app TV-ready if it only launches from phone/tablet launcher metadata.

---

## Step 2 - Remote-First Interaction

1. Every primary action must be reachable with D-pad and Select/OK.
2. Back must close overlays first, then return through game screens, then reach the launcher.
3. Do not depend on a Menu button for required controls.
4. Avoid hover-only, drag-only, pinch, or long-press-only interaction.
5. On-screen controller instructions must use neutral, compatible button labels rather than
   brand-specific art unless the platform explicitly requires it.

---

## Step 3 - Compose Focus Rules

For Compose TV or Fire TV surfaces:

1. Use stable focus targets with `focusable`, `focusRequester`, and explicit focus restoration
   for modal or screen transitions.
2. Ensure focus rings/highlights have high contrast and do not shift layout.
3. Put focusable controls in predictable visual order.
4. Keep each screen usable without touch, mouse, or keyboard.
5. Test initial focus after every screen transition, pause dialog, purchase prompt, and settings
   panel.

---

## Step 4 - 10-Foot Visual Rules

1. Use large, readable text and generous spacing for couch distance.
2. Keep critical HUD text inside TV-safe visual margins.
3. Prefer fewer, clearer choices per screen over dense phone-style forms.
4. Avoid text or button labels that truncate at 720p, 1080p, and common Fire TV display scaling.
5. Make paused, settings, purchase, and quit states visually distinct from gameplay.

---

## Step 5 - Ads, Purchases, And External Surfaces

1. Ads, if present, must be dismissible and navigable with D-pad or gamepad.
2. Do not open arbitrary web browser flows from a TV app.
3. Store purchase flows must recover focus when returning to the app.
4. Validate that paywall, restore, and error states are remote-operable.

---

## Verification

For TV game work, report:

```text
ANDROID TV GAME VERIFICATION
Manifest TV readiness: [LEANBACK_LAUNCHER/banner/touchscreen false/gamepad features]
D-pad path tested: [screens]
Back behavior tested: [screens]
Focus restoration tested: [dialogs/screens]
Resolution/text pass: [720p | 1080p | 4K | skipped + reason]
Hardware: [Fire TV | Android TV | emulator | skipped + reason]
```

---

## Hard Rules

1. Do not ship TV UX that requires touch or pointer precision.
2. Do not hide required actions behind a Menu button.
3. Do not claim Leanback readiness without manifest and banner verification.
4. Do not add a focusable element whose focused state changes layout size.
5. Do not accept purchase, ad, or error flows that trap focus.
