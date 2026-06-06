<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Skill: Godot Testing & CI (v1.1)

**Category:** Game / Testing
**Status:** Active
**Last Verified:** 2026-04-29
**Engine Target:** Godot 4.6
**Activation:** Load for Godot automated tests, headless validation, CI export checks,
scene-load smoke tests, script parse checks, GdUnit4/GUT usage, or release verification plans.

---

## Purpose

Godot projects often look healthy in the editor while CI cannot import assets, load scenes, or
export presets. This skill defines a small evidence ladder for Godot validation without forcing
a heavy test framework into every project.

---

## Current Standards Basis

- Godot command line and headless export: `https://docs.godotengine.org/en/4.6/tutorials/editor/command_line_tutorial.html`
- GdUnit4 project reference: `https://github.com/godot-gdunit-labs/gdUnit4`

---

## Step 1 - Discover The Validation Surface

1. Find `project.godot`, Godot version pinning, export presets, and existing addon test runners.
2. Identify whether the project uses GDScript, C#, GDExtension, or engine-export-only content.
3. Prefer the existing test framework if present.
4. Do not add GdUnit4, GUT, or another addon without explicit dependency approval.

---

## Step 2 - Minimum CI Ladder

Use the strongest available local check:

| Level | Check | Use when |
|-------|-------|----------|
| 1 | Static file/catalog checks | No Godot binary is available |
| 2 | `godot --headless --import --quit` | Import cache and asset pipeline need validation |
| 3 | Import/resource scan | `.import valid=false`, missing payloads, or `Failed loading resource` risk |
| 4 | Script parse check with `--headless --check-only --script <script>` | Specific scripts changed |
| 5 | Scene-load smoke script | Critical scenes, autoloads, menus, or battle scenes changed |
| 6 | Test runner addon command | Project already uses GdUnit4/GUT |
| 7 | `godot --headless --export-debug/--export-release <preset> <path>` | Export presets or release packaging changed |

Always state which levels were available and which were skipped.

---

## Step 3 - Scene-Load Smoke Tests

For behavior changes without a full test addon, prefer a tiny project-local smoke script that:

1. Loads the target `.tscn` via `load()`.
2. Instantiates it.
3. Adds it to a test tree if needed.
4. Awaits one or two frames only when lifecycle methods must run.
5. Exits with a non-zero status on error.

Do not leave ad hoc smoke scripts in production folders unless the project has a test/scripts
convention. Put them under a test or tooling path and document the command.

---

## Step 4 - Export Validation

When `export_presets.cfg` changes or Android/Desktop release artifacts matter:

1. Verify the preset name exactly matches the CLI command.
2. Ensure export templates are installed on the runner.
3. Use `--headless` on CI or non-GUI environments.
4. Export to a disposable build directory.
5. Validate artifact existence and size after export.
6. Scan export output for `Failed loading resource`, missing dependencies, and import errors.
7. Scan relevant `.import` metadata for `valid=false`.
8. For Android, pair with `skill_godot_android_export` when APK/AAB acceptance or device smoke
   is part of the task.

---

## Step 5 - Mobile Device Smoke

For mobile Godot release checks, include:

1. First scene launch.
2. Battle scene or heaviest gameplay scene when present.
3. Safe-area/notch UI check for HUD, menu, and battle commands.
4. Save path check under `user://`.
5. Logcat or platform log scan for crashes, missing resources, plugin errors, and shader/import
   failures where available.

---

## Step 6 - Test Framework Rules

1. If GdUnit4 or GUT already exists, use its documented runner commands and keep tests in the
   existing folder layout.
2. Add tests around pure scripts, resources, save/load codecs, economy math, and scene wiring
   before trying to automate visual gameplay.
3. Keep tests deterministic. Avoid real time, random seeds, external services, and editor-only
   state unless explicitly mocked or injected.

---

## Verification

For Godot testing work, report:

```text
GODOT TESTING VERIFICATION
Godot binary: [path/version | not found]
Checks run: [...]
Export presets checked: [...]
Import/resource scan: [passed | failed | skipped + reason]
Mobile smoke: [first scene | battle scene | safe-area UI | save path | logcat | skipped + reason]
Test framework: [existing runner | none | skipped]
Skipped checks: [reason]
Residual risk: [scene/input/export/device]
```

---

## Hard Rules

1. Do not claim Godot tests ran unless the Godot binary or runner actually executed.
2. Do not add a third-party test addon without explicit approval and dependency review.
3. Do not rely on editor-only success when CI/export behavior is the risk.
4. Do not skip export validation when export presets or Android signing settings changed.
5. Do not hide missing hardware, missing export templates, or missing Godot binary.
6. Do not accept an APK/AAB when export logs show `Failed loading resource` or `.import`
   metadata shows `valid=false`.
