<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Godot Performance & Mobile Readiness (v2.0)

**Category:** Game / Performance
**Status:** Active
**Last Verified:** 2026-04-29
**Engine Target:** Godot 4.6
**Activation:** Load for Godot FPS, frame spikes, mobile renderer constraints, draw calls,
overdraw, shaders, texture memory, object pooling, physics/process optimization, Android/iOS
performance, HD-2D mobile quality tiers, or release-readiness profiling.

---

## Purpose

Godot performance work must be profiler-led and platform-aware. This skill keeps optimization
focused on frame budget, asset budget, rendering mode, and scene/process discipline instead of
guesswork.

---

## Current Standards Basis

- Godot performance docs: `https://docs.godotengine.org/en/4.6/tutorials/performance/index.html`
- Godot multiple resolutions: `https://docs.godotengine.org/en/4.6/tutorials/rendering/multiple_resolutions.html`
- Godot Android export: `https://docs.godotengine.org/en/4.6/tutorials/export/exporting_for_android.html`

---

## Step 1 - Measure Before Optimizing

1. Identify the target device class and frame budget before editing.
2. Use Godot monitors/profiler, platform logs, and release/export builds where possible.
3. Separate CPU, GPU, physics, script, asset loading, and memory symptoms.
4. Do not optimize broad architecture until the bottleneck has evidence.

---

## Step 2 - Runtime Discipline

1. Disable `_process` and `_physics_process` when not needed.
2. Prefer event-driven signals/timers over per-frame polling for UI and menus.
3. Pool frequently spawned/despawned objects only when profiling or gameplay patterns justify it.
4. Avoid deep scene trees for hot replicated entities.
5. Keep expensive calculations out of UI redraw and animation callbacks.

---

## Step 3 - Rendering And Assets

1. Choose renderer and quality settings for the lowest target device, not the dev workstation.
2. For HD-2D mobile, default to the Godot Mobile renderer for modern Android/iOS targets, keep
   Compatibility as a low-end fallback, and require evidence before using Forward+ on mobile.
3. Treat built-in DOF, SSAO, volumetric fog, real-time blur, heavy bloom, and high-resolution
   dynamic shadows as mobile risk items.
4. Reduce draw calls, overdraw, lights, particles, and dynamic shadows before reducing gameplay.
5. Check UI overdraw and draw calls separately from world rendering; translucent JRPG panels,
   nested CanvasItems, and full-screen blur can dominate phone GPUs.
6. Use texture import settings deliberately: compression, mipmaps, filter mode, max size, atlas
   shape, and `.import valid=true`.
7. Verify exported texture payloads for important sprites/UI sheets; APK/AAB acceptance must not
   rely on `.import` metadata alone.
8. Keep shader complexity bounded on mobile. Test animated shaders, Sprite3D lighting, and post
   effects on exported hardware before promoting them into a quality tier.
9. For pixel/HD-2D assets, preserve crispness while still respecting texture memory and atlas size.

---

## Step 4 - Loading And Memory

1. Avoid loading all scenes/assets at boot.
2. Use staged loading or threaded resource loading for heavy assets when appropriate.
3. Release references to scenes/resources that are no longer active.
4. Treat Android low-memory kills and launch crashes as release blockers.
5. Validate exported builds, not editor-only runs, for memory-heavy scenes.

---

## Step 5 - Mobile Readiness

1. Test touch/controller input and orientation under exported builds.
2. Check thermal/battery-sensitive loops: timers, AI, particles, shaders, and audio.
3. Keep UI readable after stretch/scaling changes.
4. For HD-2D mobile, profile first scene, battle scene, and the most transparent/ornate UI scene.
5. Pair with `skill_godot_hd2d_mobile_rendering` for renderer/camera/post-effect profile choices.
6. Pair with `skill_godot_android_export` when the target is Android packaging.

---

## Verification

For Godot performance work, report:

```text
GODOT PERFORMANCE VERIFICATION
Target device/class: [...]
Bottleneck evidence: [CPU | GPU | memory | loading | unknown]
Profiler/monitor used: [...]
Renderer/profile: [...]
Post-effect risk: [none | fake | built-in + hardware evidence]
UI overdraw/draw calls: [checked | skipped + reason]
Texture/import validity: [checked | skipped + reason]
Export build tested: [yes/no + reason]
Frame/memory result: [...]
Remaining risk: [...]
```

---

## Hard Rules

1. Do not optimize from intuition alone when profiling is available.
2. Do not accept editor-only performance evidence for mobile release claims.
3. Do not leave per-frame processing enabled on inactive systems.
4. Do not add mobile shaders, particles, or dynamic shadows without hardware verification when
   they are on hot gameplay screens.
5. Do not trade away gameplay correctness for performance without naming the product impact.
6. Do not accept HD-2D mobile post-processing or Sprite3D lighting tiers without exported-device
   evidence.
7. Do not ignore `.import valid=false`, missing texture payloads, or export log resource failures
   when judging APK/AAB readiness.

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
