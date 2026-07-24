<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Godot Input, Save, and Audio (v2.0)

**Category:** Game / Systems
**Status:** Active
**Last Verified:** 2026-04-29
**Engine Target:** Godot 4.6
**Activation:** Load for Godot InputMap, controller/touch remapping, pause handling,
save/load files, settings persistence, `user://`, ConfigFile, Resource saves, audio buses,
mixing, music/SFX routing, or input/audio/save cross-system wiring.

---

## Purpose

Input, persistence, and audio are cross-cutting runtime systems. This skill keeps them explicit
so gameplay scripts do not grow hidden device assumptions, brittle save formats, or one-channel
audio mixes.

---

## Current Standards Basis

- Godot InputEvent / InputMap: `https://docs.godotengine.org/en/4.6/tutorials/inputs/inputevent.html`
- Godot controller docs: `https://docs.godotengine.org/en/4.6/tutorials/inputs/controllers_gamepads_joysticks.html`
- Godot saving games: `https://docs.godotengine.org/en/4.6/tutorials/io/saving_games.html`
- Godot audio buses: `https://docs.godotengine.org/en/4.6/tutorials/audio/audio_buses.html`

---

## Step 1 - Input Actions First

1. Define actions in `InputMap` before binding code to physical keys/buttons.
2. Use semantic action names: `move_left`, `confirm`, `cancel`, `pause`, `open_inventory`.
3. Support multiple physical inputs per action where needed: keyboard, controller, touch, or D-pad.
4. Store runtime remaps separately; `InputMap` runtime changes are not automatically persisted.
5. Keep UI navigation actions distinct from gameplay actions when remapping could conflict.

---

## Step 2 - Controller And Touch Rules

1. Test dead zones and analog/digital differences for movement.
2. Do not assume keyboard echo behavior matches controller button behavior.
3. For touch controls, keep virtual controls optional unless mobile/touch is the primary target.
4. For TV/controller targets, ensure pause, cancel, and confirm are reachable without touch.

---

## Step 3 - Save And Settings

1. Save user data under `user://`, not `res://`.
2. Include a save schema version in persistent data.
3. Separate player progress saves from settings saves.
4. Use `ConfigFile` for simple settings and structured save codecs for game state.
5. Use `Resource` saves only when the project already treats saved data as resources and the
   security/trust boundary is understood.
6. Validate missing, old-version, or corrupt save files without crashing the boot flow.

---

## Step 4 - Audio Buses

1. Define at least `Master`, `Music`, `SFX`, and `UI` buses for release-facing games.
2. Route `AudioStreamPlayer` nodes to named buses instead of relying on `Master`.
3. Keep volume settings persisted and applied at boot.
4. Avoid clipping; leave headroom on `Master`.
5. Pause or route audio intentionally during pause/menu, scene transitions, and backgrounding.

---

## Verification

For input/save/audio work, report:

```text
GODOT RUNTIME SYSTEMS VERIFICATION
Input actions changed: [...]
Devices tested: [keyboard | touch | controller | D-pad | skipped + reason]
Save paths: [user:// files/resources/settings]
Corrupt/missing save behavior: [tested | skipped + reason]
Audio buses: [Master/Music/SFX/UI/etc.]
Pause/background behavior: [tested | skipped + reason]
```

---

## Hard Rules

1. Do not hardcode physical keys/buttons directly in gameplay logic when an `InputMap` action
   belongs there.
2. Do not write user progress to `res://`.
3. Do not ship a save format without a version or migration story.
4. Do not route all audio through `Master` in a release-facing game.
5. Do not claim controller support without testing controller confirm/cancel/pause paths.

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
