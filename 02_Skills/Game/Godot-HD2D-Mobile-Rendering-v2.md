<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Godot HD-2D Mobile Rendering (v2.0)

**Category:** Game / Rendering / Mobile
**Status:** Active
**Last Verified:** 2026-04-30
**Engine Target:** Godot 4.6
**Activation:** Load for Godot HD-2D mobile render architecture, low-resolution world viewports,
native-resolution UI separation, renderer profile decisions, camera profile decisions, pixel
texture imports, mobile post-processing budgets, or Android/iOS quality tiers.

---

## Purpose

This skill owns the mobile render stack between HD-2D map design, Sprite3D art, UI runtime, and
performance. It turns desktop-style HD-2D presentation into budgeted mobile profiles.

Load with:

- `skill_godot_performance_mobile` for profiling and device evidence.
- `skill_godot_ui_runtime` when UI layers or safe-area shells are touched.
- `skill_hd2d_sprite_pipeline` when Sprite3D materials or imported pixel textures are touched.

---

## Render Architecture

Use separate render paths for world and UI:

1. Render the HD-2D world through a fixed low-resolution `SubViewport` when the project needs a
   pixel/miniature world look.
2. Present that viewport through a `SubViewportContainer` or texture-backed display node sized by
   the main scene.
3. Render HUDs, menus, battle commands, and text in a native-resolution `CanvasLayer`.
4. Keep UI text vector-rendered through Godot `Control` nodes, not inside the low-res world
   viewport.
5. Test the exported build on physical devices before accepting viewport scaling, touch alignment,
   or text sharpness.

Do not downscale the main UI just to match the world pixels.

---

## Renderer Profile

Choose the renderer by target evidence:

| Profile | Use when | Default posture |
|---------|----------|-----------------|
| Mobile | Modern Android/iOS HD-2D target | Default for mobile unless project evidence says otherwise |
| Compatibility | Low-end device reach, older GPU risk, simpler materials | Fallback profile with reduced lighting/post effects |
| Forward+ | Desktop, non-mobile, or explicitly high-end hardware evidence | Do not default to this for mobile |

Mark renderer claims as verification requirements when they come from research notes rather than
project/device evidence.

---

## Camera Decision Matrix

Choose the camera for gameplay readability before chasing trailer aesthetics:

| Goal | Camera |
|------|--------|
| Diorama depth, cinematic towns, high-end showcase | Narrow-FOV perspective, usually 35-42 degrees |
| Readability-first phone gameplay | Orthographic or constrained perspective with stable sprite scale |
| Mixed combat/exploration | Per-scene profile: readable battle camera, cinematic exploration camera |
| Low-end fallback | Orthographic/constrained perspective, fewer depth-dependent effects |

Do not encode "never orthographic" as a rule. Require a profile decision and a device readability
pass.

---

## Mobile Post-Processing

Use fakes first:

- DOF: foreground/edge blur sprites, depth bands, vignette masks, or art-directed foreground props.
- Fog: mesh planes, gradient overlays, particles with strict count limits, or simple color ramps.
- Bloom/glow: additive sprites, emissive accents, or pre-baked highlights.
- Ambient depth: baked lighting, painted occlusion, low-count lights, and tight shadow ranges.

Use built-in DOF, SSAO, volumetric fog, real-time blur, heavy bloom, and high-resolution shadows
only behind named quality tiers that have exported hardware evidence.

---

## Pixel Texture Imports

For pixel art:

1. Use nearest filtering for crisp sprites and UI icons.
2. Use mipmaps/linear filtering only for textures that must recede smoothly in 3D space.
3. Keep transparent sprites as PNG sources; choose compression/import settings deliberately.
4. Verify `.import` files are valid and exported texture payloads are present before accepting an
   APK/AAB.
5. Use atlases to reduce texture binds without creating unmanageably large mobile textures.

---

## Quality Tiers

Define quality tiers as data, not scattered conditionals:

| Tier | Rendering stance |
|------|------------------|
| Low | Compatibility or reduced Mobile profile, fake fog/DOF, minimal dynamic lights/shadows |
| Medium | Mobile renderer, limited glow/fog fakes, bounded lights, conservative sprite materials |
| High | Mobile renderer with hardware-proven post effects and shader variants |
| Desktop/Cinematic | Forward+ or high-end settings if the target is not mobile-first |

Each tier must name target devices, renderer, viewport scale, lighting, post effects, texture
limits, and acceptance checks.

---

## Verification

For HD-2D mobile rendering work, report:

```text
HD-2D MOBILE RENDERING VERIFICATION
Renderer profile: [Mobile | Compatibility | Forward+ + reason]
World/UI split: [SubViewport world | native CanvasLayer UI | not applicable]
Camera profile: [narrow-FOV perspective | orthographic | constrained perspective + reason]
Post effects: [fake | built-in quality tier + hardware evidence | none]
Pixel imports: [nearest/mipmaps/compression checked | skipped + reason]
Device export: [device/artifact/logs | skipped + reason]
Unverified claims: [none | list]
```

---

## Hard Rules

1. Do not default mobile HD-2D scenes to Forward+, SSAO, built-in DOF, volumetric fog, real-time
   blur, heavy bloom, or high-res shadows.
2. Do not render combat HUDs or menus inside the low-resolution world viewport.
3. Do not treat research claims as hard standards until project/device verification exists.
4. Do not accept shader or post-effect quality tiers without exported hardware evidence.
5. Do not hide pixel import failures behind a successful APK/AAB build.

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
