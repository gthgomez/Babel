<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Skill: Godot Input, Save, and Audio (v1.0)

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
