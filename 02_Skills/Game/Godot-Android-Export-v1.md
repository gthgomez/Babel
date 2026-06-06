<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Skill: Godot Android Export (v1.1)

**Category:** Game / Android Export
**Status:** Active
**Last Verified:** 2026-04-29
**Engine Target:** Godot 4.6
**Activation:** Load for Godot Android exports, APK/AAB generation, export presets,
package names, signing, Android plugins, IAP, permissions, Play/TV submission, or device
smoke testing of Godot builds.

---

## Purpose

Godot Android export work sits between engine configuration and Android store requirements.
This skill governs export presets, signing, artifact choice, plugins, permissions, and device
validation without confusing engine exports with native Android app builds.

Use Android store skills when the task touches Play, Amazon, Samsung, billing policy, or store
submission beyond the Godot export itself.

---

## Current Standards Basis

- Godot Android export: `https://docs.godotengine.org/en/4.6/tutorials/export/exporting_for_android.html`
- Godot command-line export: `https://docs.godotengine.org/en/4.6/tutorials/editor/command_line_tutorial.html`
- Godot Android plugins: `https://docs.godotengine.org/en/4.6/tutorials/platform/android/android_plugin.html`
- Godot Android IAP: `https://docs.godotengine.org/en/4.6/tutorials/platform/android/android_in_app_purchases.html`

---

## Step 1 - Inspect Export State

Before editing:

1. Read `project.godot`.
2. Read `export_presets.cfg` if present.
3. Identify Godot version, renderer, architecture filters, package name, min/target SDK, and
   custom Android template use.
4. Check whether the project exports APK, AAB, or both.
5. Check whether the task is engine export, store packaging, billing/IAP, or plugin integration.

---

## Step 2 - Signing And Secrets

1. Keep release keystores and passwords out of the repo.
2. Use Godot's Android export preset fields or environment variables for CI:
   `GODOT_ANDROID_KEYSTORE_RELEASE_PATH`, `GODOT_ANDROID_KEYSTORE_RELEASE_USER`, and
   `GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD`.
3. Uncheck debug export for release artifacts.
4. Never commit keystores, plaintext passwords, or generated release credentials.
5. If signing is missing, produce a blocker instead of silently exporting a debug artifact.

---

## Step 3 - Artifact Choice

1. Prefer AAB for Google Play distribution.
2. Use APK for local device smoke tests, sideloading, or stores that require APK.
3. For APK size work, inspect enabled architectures and export template features.
4. Do not disable 64-bit architecture for store-bound builds.
5. Validate package name/application id before release. It must be stable once published.

---

## Step 4 - Plugins, IAP, And Permissions

1. Prefer official or project-approved Android plugins.
2. Match plugin setup to the active Godot version and Android template mode.
3. Add only the permissions required by actual features.
4. For IAP, pair this skill with Android store/billing skills because purchase policy differs
   across Google Play, Amazon Appstore, and Samsung.
5. Re-run export and device smoke checks after plugin or permission changes.

---

## Step 5 - Device Smoke

For Android export changes, verify:

1. Install and launch the debug or release candidate artifact on a real device when available.
2. Check first scene load, battle scene load when present, orientation, input, audio,
   pause/resume, and `user://` save path behavior.
3. Check safe-area/notch layout for HUDs, menus, and battle commands.
4. Capture adb logcat for crashes, `Failed loading resource`, missing plugin classes, and asset
   import errors where available.
5. For TV targets, pair with `skill_android_tv_game_ux`.

---

## Step 6 - Asset Import Acceptance

Android export acceptance must include import/resource checks:

1. Scan Godot export logs for `Failed loading resource`, missing dependencies, and import errors.
2. Scan changed or critical `.import` files for `valid=false`.
3. Confirm important sprites, UI sheets, fonts, and audio have exported payloads where practical;
   do not accept an APK/AAB that only contains stale `.import` metadata.
4. Treat missing transparent textures, broken Sprite3D sheets, and absent UI fonts as release
   blockers even when the APK/AAB file exists.

---

## Verification

For Godot Android export work, report:

```text
GODOT ANDROID EXPORT VERIFICATION
Godot version: [...]
Preset/artifact: [APK | AAB | both]
Signing: [debug | release env | release local | blocked]
Command run: [...]
Device smoke: [device | emulator | skipped + reason]
Resource/import scan: [passed | failed | skipped + reason]
Scenes smoked: [first scene | battle scene | safe-area UI | save path | list]
Store/billing skills paired: [yes/no + list]
```

---

## Hard Rules

1. Do not commit keystores or signing passwords.
2. Do not call a debug-signed artifact release-ready.
3. Do not change package names casually after publication.
4. Do not add broad Android permissions without a feature-level reason.
5. Do not treat a successful desktop run as evidence that Android export works.
6. Do not ignore export log `Failed loading resource` lines or `.import valid=false`.
7. Do not call an APK/AAB accepted when critical imported textures or fonts are missing.
