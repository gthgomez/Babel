<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Godot Mobile JRPG UX (v2.0)

**Category:** Game / UI / Mobile UX
**Status:** Active
**Last Verified:** 2026-04-30
**Engine Target:** Godot 4.6
**Activation:** Load for mobile JRPG battle menus, touch-first command layouts, one-handed phone
UX, safe-area/notch handling, portrait/landscape battle HUD variants, tap-preview/confirm
interaction, Android back/cancel behavior, accessibility settings, haptics, or physical-device
usability checks.

---

## Purpose

This skill adapts premium JRPG menus and battle HUDs for phones without losing readable RPG
mechanics. It complements `skill_godot_hd2d_rpg_ui`, which owns the HD-2D JRPG visual grammar.

Load with:

- `skill_godot_ui_runtime` for `CanvasLayer`, focus, cancel/back, and responsive layout.
- `skill_godot_ui_theme` for touch-size tokens, typography, and panel styling.
- `skill_godot_input_save_audio` when settings, haptics, or input remapping are edited.

---

## Touch Layout Rules

1. Use 48dp minimum touch targets for all interactive controls.
2. Use at least 8dp spacing between frequent-action controls.
3. Prefer 64-72dp command targets for battle actions when the screen allows it.
4. Keep primary commands in the lower thumb zone for one-handed phone use.
5. Keep destructive or turn-committing actions away from accidental edge taps.
6. Keep menus shallow: prefer one to three levels, with scroll lists and detail panes over deep
   command trees.

---

## Safe Area Root

Create a top-level safe-area shell for phone layouts:

```gdscript
var safe_rect := DisplayServer.get_display_safe_area()
```

Apply safe-area padding to HUD roots, battle commands, footer hints, and modal panels. Verify
notches, rounded corners, gesture bars, and landscape cutouts on exported device builds.

---

## Battle Layout Variants

Design explicit variants instead of stretching one console HUD:

| Context | Preferred layout |
|---------|------------------|
| Portrait phone | Bottom sheet or 2x2 command grid, top turn-order strip, collapsible party panel |
| Landscape phone | Bottom command row/grid, side party status, top turn-order strip |
| Tablet | Two-pane command/detail layout with larger status affordances |
| Controller/desktop | Vertical command list remains acceptable |

For all variants, keep weakness, boost, break, cost, target, and turn-order state visible near the
decision path.

---

## Interaction Model

1. Use tap-to-preview for skills, items, targets, and status details.
2. Use confirm-to-commit for actions that spend a turn, consume resources, or change save state.
3. Use long-press for extended info when hover/tooltips are unavailable.
4. Use swipe paging only for natural paged lists, party pages, bestiaries, or logs.
5. Map Android Back to cancel, close modal, step up one menu level, or pause; never silently quit
   from gameplay.
6. Give immediate lightweight feedback on button-down where appropriate, but commit on release or
   explicit confirm for risky actions.

---

## Accessibility And Settings

Provide or preserve settings for:

- text size tiers using theme sizes, not viewport-width font scaling
- reduced motion for panel transitions and battle feedback
- high contrast or readable contrast variant
- haptics on/off and intensity where supported
- UI scale only through controlled project settings

Keep font sizes readable on the smallest target device before adding ornament.

---

## Verification

For mobile JRPG UX work, report:

```text
MOBILE JRPG UX VERIFICATION
Layouts checked: [portrait | landscape | tablet | controller/desktop]
Touch targets: [48dp+ verified | risk list]
Safe area: [DisplayServer safe area applied/tested | skipped + reason]
Battle decisions: [preview/confirm/back/cancel checked]
Accessibility settings: [text size | reduced motion | contrast | haptics | skipped + reason]
Physical device: [device/build/logs | skipped + reason]
```

---

## Hard Rules

1. Do not shrink battle commands below 48dp to preserve decorative layout.
2. Do not place the main mobile command flow outside the reachable lower thumb area without a
   project-specific reason.
3. Do not accept phone UI without safe-area verification.
4. Do not commit turn-ending actions on first ambiguous tap when preview/confirm is needed.
5. Do not claim mobile usability from desktop resizing alone.

---

## Boundaries — Do Not Overstep
- This skill provides Babel-specific Godot engine conventions. It does not replace official Godot documentation or the Godot Asset Library.
- Version-specific guidance (Godot 4.6, GDScript patterns, export templates) must be verified against current Godot stable releases before use in production plans.

## Failure Behavior of This Skill
- **Referenced Godot version or API is outdated:** Flag as STALE. Recommend web-search verification against current Godot documentation.
- **Platform-specific guidance conflicts with another skill:** Activate `coherence-linter` to detect and resolve.
- **Export/build guidance fails on target platform:** Verify against current Godot export documentation. Flag platform-specific issues explicitly.

## Strategic Next Move
After every substantial response, end with one strategic next-move question focused on the highest-leverage validation step (verify the build, check an export setting, confirm a GDScript pattern).

## References
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening Godot patterns.
- `skill_standards_currency_audit` (`02_Skills/Governance/Standards-Currency-Audit-v2.md`) — for scheduled re-verification of Godot version pins.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting contradictions across Godot skills.

---

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-19.
