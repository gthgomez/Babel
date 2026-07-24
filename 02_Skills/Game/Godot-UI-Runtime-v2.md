<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Godot UI Runtime (v2.0)

**Category:** Game / UI
**Status:** Active
**Last Verified:** 2026-04-29
**Engine Target:** Godot 4.6
**Activation:** Load for Godot HUDs, menus, pause/settings screens, Control-node runtime
behavior, CanvasLayer overlays, focus/controller navigation, localization, responsive UI, or
game UI state wiring.

---

## Purpose

`skill_godot_ui_theme` covers theme resources and visual styling. This skill covers runtime UI:
screen structure, focus behavior, HUD separation, modal flow, localization, and resolution
behavior. Load both when the task changes both interaction and styling.

---

## Current Standards Basis

- Godot UI docs: `https://docs.godotengine.org/en/4.6/tutorials/ui/index.html`
- Godot containers: `https://docs.godotengine.org/en/4.6/tutorials/ui/gui_containers.html`
- Godot resolutions/stretch: `https://docs.godotengine.org/en/4.6/tutorials/rendering/multiple_resolutions.html`
- Godot internationalization: `https://docs.godotengine.org/en/4.6/tutorials/i18n/internationalizing_games.html`

---

## Workflow

1. Identify whether the UI is HUD, menu, overlay modal, settings, inventory, dialogue, or editor
   tooling. Do not mix these roles in one scene script.
2. Use `CanvasLayer` for screen-space HUD/menus above gameplay when gameplay remains active.
3. Use `Control` nodes for UI and keep layout nodes separate from content nodes.
4. Use containers for adaptive layout. Use anchors for top-level shells and simple edge pins.
5. Keep simulation state out of UI scripts. UI scripts may render state and emit intent signals.
6. Define focus entry, focus restoration, and cancel/back behavior for every interactive screen.
7. Route translated strings through Godot localization instead of hardcoded gameplay text when
   the screen is player-facing.
8. Verify stretch settings and text fit at the project's minimum and maximum target resolutions.

---

## Runtime Structure Rules

| UI surface | Recommended root |
|------------|------------------|
| Always-visible HUD | `CanvasLayer` -> `Control` |
| Pause/settings menu | `CanvasLayer` -> modal `Control` |
| Main menu | `Control` scene, optionally with background viewport |
| In-world prompt | `Control` in HUD or `Label3D` only when it must live in world space |
| Tool/editor panel | `Control` plus explicit plugin/tool separation |

Do not put business logic, pathfinding, combat, economy, or save/load mutation inside UI scene
scripts.

---

## Focus And Input

1. Every interactive screen must work with keyboard/controller navigation.
2. Set focus mode only on actual interactive targets.
3. Define an initial focus target after scene enter and after modal close.
4. Use focus neighbors only when automatic navigation fails or the visual order is non-linear.
5. Keep cancel/back handling consistent across pause, settings, confirmation, and store dialogs.

---

## Resolution And Text

1. Choose stretch mode and aspect policy deliberately before tuning pixel positions.
2. Use containers, size flags, and minimum sizes instead of manual offsets for complex panels.
3. Expose UI scale only through a controlled setting; do not mutate random node scales.
4. Check longest localized strings before declaring a panel done.
5. Avoid clipping dynamic labels in buttons, inventory rows, dialogue boxes, and subtitles.

---

## Verification

For Godot UI runtime work, report:

```text
GODOT UI VERIFICATION
Screens touched: [...]
Root/UI structure: [CanvasLayer/Control/other]
Focus path: [keyboard/controller tested | skipped + reason]
Resolution pass: [target sizes tested | skipped + reason]
Localization/text-fit risk: [none | list]
Runtime separation: [UI-only | signals to game logic | mixed + justification]
```

---

## Hard Rules

1. Do not manually position complex UI that should be container-driven.
2. Do not put gameplay mutation in UI scripts except through explicit intent signals or a thin
   controller call boundary.
3. Do not accept a menu that requires mouse-only input unless the project is explicitly mouse-only.
4. Do not claim responsive UI without checking stretch settings and at least two target sizes.
5. Do not hardcode player-facing strings when the project already has localization infrastructure.

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

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-19 per Beyond the OLS-MCC Roadmap Workstream C Target 3.
