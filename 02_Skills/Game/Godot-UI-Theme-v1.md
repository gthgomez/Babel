# Godot UI & Theme System (v1.1)

**Category:** Game / UI / Theme
**Status:** Active
**Last Verified:** 2026-04-30
**Engine Target:** Godot 4.6
**Activation:** Load for Godot Theme resources, Control styling, RPG/JRPG UI tokens, fonts,
StyleBox/NinePatch panels, touch-size tokens, safe-area spacing, focus styling, or high-end
glass/blur decisions.

---

## Purpose

Build professional, responsive, maintainable Godot UI through centralized `Theme` resources and
reusable style tokens. Pair with `skill_godot_ui_runtime` for behavior and
`skill_godot_mobile_jrpg_ux` for touch-first battle/menu ergonomics.

---

## Theme Rules

1. Store fonts, colors, margins, constants, icons, and StyleBoxes in a `.theme` resource applied
   at the UI root.
2. Use `MarginContainer`, `VBoxContainer`, `HBoxContainer`, `GridContainer`, and anchors instead
   of manual positions for complex screens.
3. Keep UI scripts focused on visual updates and signals; do not bury gameplay logic in styled
   controls.
4. Create custom controls by inheriting from `Control` or `Button` with exported styling/state
   properties.
5. Confirm keyboard/controller focus styling through `Focus Mode`, focus neighbors where needed,
   and a visible focus state.

---

## Mobile JRPG Tokens

Define these as theme constants or project UI tokens:

| Token | Baseline |
|-------|----------|
| `touch_target_min` | 48dp minimum |
| `command_row_height` | 56-72dp on phone battle screens |
| `chip_size_small` | 24dp for weakness/status chips |
| `chip_size_large` | 32-40dp for active battle mechanics |
| `safe_area_padding` | from `DisplayServer.get_display_safe_area()` plus design gutter |
| `disabled_opacity` | 0.38-0.50, with non-color state cue when possible |
| `footer_hint_gap` | 8-12dp between hint groups |
| `focus_glow` | subtle outline/glow distinct from hover and selected |

Panel variants should be named by purpose:

- `Panel.Content`
- `Panel.Command`
- `Panel.Modal`
- `Panel.BattleStatus`
- `Panel.Description`

Use `StyleBoxFlat` for simple scalable panels and `NinePatchRect`/`StyleBoxTexture` for ornate
JRPG frames.

---

## Font Roles

Use readable font roles instead of one font everywhere:

| Role | Use |
|------|-----|
| Display serif | titles, character names, major commands |
| Body sans or readable serif | descriptions, dialogue, settings, list rows |
| Numbers/slab/tabular | HP/SP, costs, turn counters, inventory quantities |
| Pixel accent | short labels or icons only |

Do not scale fonts by viewport width. Use theme size tiers plus a user text-size setting. Import
fonts as proper `FontFile` resources and verify small text on target devices.

---

## Motion And Effects

Use `Tween` for restrained focus pulses, button feedback, and panel entrance/exit. Keep reduced
motion support available when UI animation affects readability.

Real-time blur, glassmorphism, `BackBufferCopy`, and expensive translucent stacks are high-end
mobile features only. Prefer opaque/semi-opaque panels for normal phone tiers unless exported
hardware evidence supports blur.

---

## Verification

For Godot theme work, report:

```text
GODOT THEME VERIFICATION
Theme resource: [path | missing]
Tokens touched: [...]
Font roles: [display/body/numbers/accent checked | skipped + reason]
Touch/safe area: [48dp/safe-area tokens checked | skipped + reason]
Focus state: [keyboard/controller/touch checked | skipped + reason]
Effects tier: [none | cheap | high-end hardware-tested]
```

---

## Hard Rules

1. Do not scatter one-off font, color, margin, or StyleBox overrides across scenes.
2. Do not shrink touch targets below 48dp for mobile ornament.
3. Do not use viewport-width font scaling as the primary responsive strategy.
4. Do not use real-time blur/glass on mobile without a high-end quality tier and device evidence.
5. Do not accept a theme without visible focus, disabled, selected, and pressed states.
