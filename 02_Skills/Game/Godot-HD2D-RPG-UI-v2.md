<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Godot HD-2D RPG UI (v2.0)

**Category:** Game / UI / RPG
**Status:** Active
**Last Verified:** 2026-04-29
**Engine Target:** Godot 4.6
**Reference Style:** Octopath Traveler / Triangle Strategy adjacent HD-2D JRPG interface
**Activation:** Load for HD-2D RPG menus, JRPG battle command UI, mobile battle/menu variants,
ornate fantasy panels, weakness/boost/break/status HUDs, party status layouts, dialogue boxes,
item/inventory lists, NinePatchRect RPG frames, serif fantasy UI typography, or Octopath-like UI
direction.

---

## Purpose

This skill governs the visual and interaction grammar of an HD-2D JRPG interface in Godot.
It translates the Octopath-style pattern into reusable Godot UI rules without copying
proprietary Square Enix assets, logos, fonts, or exact layouts.

Load with:

- `skill_godot_ui_runtime` for CanvasLayer, focus, localization, and responsive behavior.
- `skill_godot_ui_theme` for Theme resources, fonts, colors, and stylebox centralization.
- `skill_godot_mobile_jrpg_ux` for phone touch targets, safe areas, and battle layout variants.
- `skill_hd2d_sprite_pipeline` when UI icons are pixel-art sheets or battle sprites.

---

## Current Standards Basis

- Unreal Engine Octopath Traveler HD-2D interview:
  `https://www.unrealengine.com/spotlights/octopath-traveler-s-hd-2d-art-style-and-story-make-for-a-jrpg-dream-come-true`
- Unreal Engine Octopath Traveler II interview:
  `https://www.unrealengine.com/developer-interviews/octopath-traveler-ii-builds-a-bigger-bolder-world-in-its-stunning-hd-2d-style`
- Godot containers:
  `https://docs.godotengine.org/en/4.6/tutorials/ui/gui_containers.html`
- Godot fonts:
  `https://docs.godotengine.org/en/4.6/tutorials/ui/gui_using_fonts.html`

---

## Core UI Grammar

The target look is not "pixel UI everywhere." It is a readable modern UI with handcrafted
JRPG ornament:

1. Dark translucent parchment/ink panels over bright HD-2D scenes.
2. Thin gold/cream borders with pixel-art or engraved corner ornaments.
3. Serif typography for names, commands, and descriptions; compact icon chips for mechanics.
4. Controller/desktop vertical command lists and mobile bottom-sheet/grid variants with clear
   confirm/cancel paths.
5. Mechanical state shown visually: weakness icons, shield/break count, boost pips, turn order,
   HP/SP, status effects, and selected-target hints.
6. Motion is restrained: cursor glide, focus glow, panel fade, and small scale/alpha changes.

Do not make the UI look like a generic web dashboard, mobile card stack, or neon arcade HUD.

---

## Godot Scene Pattern

Use a small set of reusable scenes:

```text
RpgHudLayer (CanvasLayer)
  BattleHudRoot (Control)
    TurnOrderBar (HBoxContainer)
    EnemyStatusLayer (Control)
    PartyStatusPanel (HBoxContainer)
    BattleCommandPanel (NinePatchRect)
    ContextDescriptionPanel (NinePatchRect)

RpgMenuLayer (CanvasLayer)
  MenuRoot (Control)
    HeaderPanel (NinePatchRect)
    CommandListPanel (NinePatchRect)
    DetailPanel (NinePatchRect)
    FooterHintBar (HBoxContainer)
```

Keep reusable pieces as separate scenes:

- `RpgPanel.tscn`
- `CommandRow.tscn`
- `WeaknessChip.tscn`
- `BoostPip.tscn`
- `PartyStatusRow.tscn`
- `TurnOrderPortrait.tscn`
- `DescriptionBox.tscn`

Use containers for layout. Use custom drawing or manual offsets only for ornaments, separator
lines, and tiny icon alignment fixes.

---

## Panel And Frame Construction

Use `NinePatchRect` for every reusable ornate panel:

1. Center fill: dark navy/black-brown with high alpha, usually 0.82-0.92.
2. Border: thin warm cream, brass, or muted gold.
3. Corners: 16x16, 24x24, or 32x32 pixel-art flourishes.
4. Divider lines: 1-2 px warm desaturated strokes.
5. Outer shadow: soft, low alpha; never a huge web-style drop shadow.

Panel names should describe function, not art:

- `BattleCommandPanel`
- `TargetInfoPanel`
- `PartyStatusPanel`
- `InventoryDetailPanel`

Do not nest decorative panels inside decorative panels. If a panel needs grouping, use dividers
or subtle bands inside the same frame.

---

## Typography

1. Prefer a readable bookish serif for commands, names, and descriptions.
2. Use a simpler sans or small-caps face only for tiny metadata if the serif becomes muddy.
3. Use dynamic fonts in Godot. Do not rasterize all text into sprites.
4. Keep body text readable at the lowest target resolution before adding ornament.
5. Reserve pixel fonts for small labels, category tags, or deliberate retro accents.

Recommended hierarchy:

| UI role | Style |
|---------|-------|
| Character names | Serif semibold, high contrast |
| Battle commands | Serif medium, generous row height |
| Descriptions | Serif regular, slightly smaller |
| Icon labels | Sans/pixel accent, short only |
| Damage/status numbers | Serif or slab with outline/shadow |

---

## Battle UI Layout

For turn-based RPG battles:

1. Bottom-left or lower-side command panel: Attack, Skills, Items, Defend, Flee, Boost.
2. Bottom/right party panel: portrait/name, HP, SP/MP, boost pips, status icons.
3. Top or side turn-order strip: compact portraits/icons with active actor emphasis.
4. Enemy info layer near enemies: name, shield count, weakness chips, break state.
5. Context panel: one-line skill/item descriptions and cost/target hints.

Make the active decision path obvious:

- one selected command row
- one target highlight
- one context description
- one clear confirm/cancel hint row

Do not show all possible details at maximum weight at once.

For mobile JRPG layouts, use the mobile UX skill and pick an explicit variant:

- portrait phone: bottom sheet or 2x2 command grid, top horizontal turn-order strip, collapsible
  party/status strip
- landscape phone: bottom command row/grid, side party status when space permits, top turn-order
  strip
- tablet: two-pane command/detail layout with larger status affordances
- controller/desktop: vertical command list remains valid

Keep the HD-2D grammar original. Acceptable motif directions include Lantern & Ink, Emberlight
Codex, Glacial Sigil, and Moonwell/Cartographer. Do not copy Octopath frame shapes, icons,
colors, fonts, or exact HUD silhouettes.

---

## Weakness, Boost, Break, And Status Chips

Use icon chips, not prose, for repeated combat mechanics.

| Mechanic | UI treatment |
|----------|--------------|
| Weapon weakness | 16-24 px icon chip in a dark slot |
| Element weakness | colored icon chip with shared shape language |
| Unknown weakness | locked/blank chip, not missing layout |
| Shield count | large readable number near weakness row |
| Break state | cracked shield/chip animation plus color shift |
| Boost pips | 3-5 small pips near actor command/status |
| Status effect | small icon with tooltip/description on focus |

Rules:

1. Unknown and revealed states must occupy the same dimensions.
2. Color alone cannot be the only differentiator; use icon silhouette too.
3. Keep chips pixel-crisp if they are pixel art, but keep text vector-rendered.
4. Animate state changes lightly: pop/fade/glow, not screen-wide motion.

---

## Menu And Inventory Layout

Use a two- or three-pane JRPG layout:

1. Left command/category list.
2. Center item/skill/member list.
3. Right detail panel for stats, descriptions, comparison, or requirements.

Always provide:

- selected row state
- disabled/unavailable row state
- cost/quantity column alignment
- footer hints for confirm, cancel, sort, details, and page actions
- detail text that updates with focus, not only after confirm

Do not make inventory cards. Repeated RPG data should scan as rows unless the game is explicitly
designed around collectible card presentation.

---

## Motion Rules

Use motion to confirm state, not to decorate constantly:

1. Cursor movement: 80-140 ms glide or instant snap with a 60-100 ms glow pulse.
2. Panel open: 120-220 ms fade/slide.
3. Boost/break: small chip pop, flash, or crack overlay.
4. HP/SP change: number tween plus brief bar color pulse.
5. Turn handoff: active portrait/row emphasis, not a large screen transition.

Avoid perpetual bobbing, large breathing panels, or heavy blur over readable text.

---

## Theme Resource Requirements

Centralize these in a Godot `Theme` or project UI constants:

- panel fill colors
- border colors
- fonts and sizes
- command row height
- chip sizes
- 48dp minimum touch targets for mobile controls
- safe-area padding for phone HUD roots and footer hints
- focus colors
- disabled row opacity
- footer hint spacing

Do not hardcode colors and font sizes across individual battle/menu scripts.

---

## Verification

For HD-2D RPG UI work, report:

```text
HD-2D RPG UI VERIFICATION
Screens touched: [...]
Reference grammar used: [battle commands | party panel | weakness chips | menu rows | dialogue]
Panel construction: [NinePatchRect/theme/custom + reason]
Focus path: [keyboard/controller tested | skipped + reason]
Mobile pass: [touch targets/safe area/layout variant tested | skipped + reason]
Resolution/text pass: [target sizes tested | skipped + reason]
Mechanic readability: [weakness/boost/break/status/turn order checked]
Asset originality: [no proprietary art copied | risk noted]
```

---

## Hard Rules

1. Do not copy Octopath Traveler UI assets, logos, exact fonts, screenshots, or proprietary
   frame art. Use the grammar, not the files.
2. Do not replace readable text with pixel-art text sprites.
3. Do not make RPG menus as card grids when dense rows are the expected interaction pattern.
4. Do not let ornaments reduce hit/focus target clarity.
5. Do not hide combat mechanics in descriptions when they should be icon/state chips.
6. Do not accept a battle UI without confirm/cancel/focus behavior verified on keyboard or
   controller when the game is not mouse-only.
7. Do not accept a mobile battle/menu UI without 48dp targets, safe-area handling, and physical
   device usability verification or an explicit skipped-check reason.

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
