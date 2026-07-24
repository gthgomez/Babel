<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Godot HD-2D Overworld Map Design (v1.1)

**Category:** Game / Map
**Status:** Active
**Last Verified:** 2026-04-29
**Engine Target:** Godot 4.6 (Node3D, CSGBox3D, Sprite3D, WorldEnvironment, ShaderMaterial)
**Reference Style:** Octopath Traveler overworld, Triangle Strategy (diorama aesthetic)

## Purpose

This skill governs the design and implementation of HD-2D diorama overworld maps in Godot 4.
It covers terrain layering, marker placement, environment shaders, lighting configuration, camera
profile choices, and separate desktop/cinematic vs mobile map profiles.

Load alongside:

- `skill_hd2d_sprite_pipeline` for Sprite3D art and material setup.
- `skill_godot_hd2d_mobile_rendering` when targeting Android/iOS or low-resolution world
  viewport architecture.

---

## 1. Scene Structure (Required Hierarchy)

Every HD-2D overworld scene must follow this node hierarchy:

```
OverworldScene (Node3D)
│
├── WorldEnvironment              ← Optional/profile-gated post-processing
├── DirectionalLight3D            ← Primary "sun" — angled 30-45° for shadow depth
├── AmbientLight (OmniLight3D)    ← Fill light to prevent pure-black undersides
│
├── Terrain (Node3D)              ← Static mesh group for ground geometry
│   ├── GroundPlane (MeshInstance3D)    ← Base walkable surface
│   ├── ElevatedPath (CSGBox3D)         ← Raised terrain, roads, bridges
│   ├── WallNorth / WallSouth (CSGBox3D)  ← Scene boundary walls (prevent camera clip)
│   └── GrassPatches (Node3D)           ← ShaderMaterial grass with sway
│
├── Props (Node3D)                ← Static billboarded sprites for dressing
│   ├── Guidepost (Sprite3D)      ← Y-Billboard, lit material
│   ├── HealSpring (MeshInstance3D) ← WaterShader material
│   └── Trees / Rocks (Sprite3D)  ← Y-Billboard, no collision
│
├── Encounters (Node3D)           ← EncounterZone Area3D triggers
├── Events (Node3D)               ← EventTrigger Area3D triggers
│
├── Player (CharacterBody3D)      ← Spawned from Player.tscn
│   └── CameraRig (Node3D)        ← Parented to Player — isometric follow
│       └── Camera3D              ← DOF + Projection settings here
│
└── OverworldUI (CanvasLayer)     ← 2D UI overlay above 3D scene
```

**Rule:** Every node must be in its assigned group. Never put terrain nodes under Props or vice
versa — this breaks batch culling on mobile.

---

## 2. Terrain Layering Rules

### Ground Plane
- Use a `MeshInstance3D` with a `PlaneMesh`. Size: match the entire playable area.
- Apply a **tiling texture** (stone path, dirt, grass) with `uv_scale` in StandardMaterial3D.
- Ground texture resolution: 512×512 px tiling tile. Use `TEXTURE_FILTER_LINEAR_WITH_MIPMAPS`
  for smooth far-distance look.

### Elevation (CSGBox3D for Prototyping, MeshInstance3D for Ship)
- Use `CSGBox3D` during development for raised terrain (steps, platforms, boss arenas).
- Convert to `MeshInstance3D` (bake CSG) before final APK export — CSG is CPU-expensive at
  runtime.
- Elevation step height: **0.5 units** per step. Never use fractional steps; they cause
  `CharacterBody3D` to stutter.
- Assign a `StaticBody3D` + `CollisionShape3D` to all elevated surfaces so the player can
  walk up them.

### Boundary Walls
- Add invisible `CSGBox3D` walls (set `visible = false`) at the map perimeter — height 6.0
  units — to prevent the camera from clipping into empty space.
- Use `collision_layer = 2` (wall layer) so `RayCast3D` can detect boundary separately
  from terrain (layer 1).

---

## 3. Environment Shaders

### Grass Sway Shader (grass_sway.gdshader)
```glsl
shader_type spatial;

uniform float wind_speed : hint_range(0.1, 5.0) = 1.2;
uniform float wind_strength : hint_range(0.0, 1.0) = 0.08;
uniform vec3 wind_direction = vec3(1.0, 0.0, 0.3);
uniform sampler2D albedo_texture : source_color;

void vertex() {
    float time_offset = TIME * wind_speed;
    float sway = sin(time_offset + VERTEX.x * 2.5 + VERTEX.z * 1.8) * wind_strength;
    // Only sway the top vertices (UV.y < 0.5 = bottom half stays grounded)
    sway *= step(UV.y, 0.5);
    VERTEX.x += wind_direction.x * sway;
    VERTEX.z += wind_direction.z * sway;
}

void fragment() {
    ALBEDO = texture(albedo_texture, UV).rgb;
    ROUGHNESS = 0.9;
    METALLIC = 0.0;
}
```

### Water / Heal Spring Shader (water.gdshader)
```glsl
shader_type spatial;

uniform float ripple_speed : hint_range(0.1, 3.0) = 0.8;
uniform float ripple_scale : hint_range(1.0, 20.0) = 8.0;
uniform vec4 water_color : source_color = vec4(0.15, 0.55, 0.85, 0.82);
uniform vec4 foam_color : source_color = vec4(0.85, 0.95, 1.0, 1.0);

void fragment() {
    vec2 uv = UV * ripple_scale;
    float ripple = sin(uv.x + TIME * ripple_speed) * sin(uv.y + TIME * ripple_speed * 0.7);
    ripple = ripple * 0.5 + 0.5;
    vec4 col = mix(water_color, foam_color, ripple * 0.25);
    ALBEDO = col.rgb;
    ALPHA = col.a;
    ROUGHNESS = 0.1;
    METALLIC = 0.3;
    EMISSION = water_color.rgb * 0.15;  // Subtle glow
}

void vertex() {
    VERTEX.y += sin(VERTEX.x * 3.0 + TIME * ripple_speed) * 0.02;
}
```

### Shader Anti-Patterns
- **Never use `TIME` in fragment shaders without damping** — it causes visual crawling at high
  values. Use `fract(TIME * speed)` or `sin(TIME * speed)` to keep range bounded.
- **Always set `ALPHA_SCISSOR_THRESHOLD`** on vegetation shaders to prevent Z-fighting with
  the ground plane. Use threshold `0.5`.
- **Never animate the base of grass vertices** — only vertices where `UV.y < 0.5`. A grounded
  base prevents the sprite from "floating."

---

## 4. Lighting And Atmosphere Profiles

Choose the profile before tuning lights or post effects:

| Profile | Defaults |
|---------|----------|
| Desktop/Cinematic | Narrow-FOV perspective, richer shadows, optional SSAO/DOF/fog/bloom after testing |
| Mobile Medium/High | Mobile renderer, fake DOF/fog/bloom first, limited lights, tight shadow budgets |
| Mobile Low | Compatibility fallback, baked/painted depth, minimal dynamic shadows, no built-in DOF/SSAO |

Do not default mobile maps to SSAO, built-in DOF, volumetric fog, heavy bloom, or high-resolution
dynamic shadows. Promote those only into named quality tiers with exported-device evidence.

### DirectionalLight3D (Sun)
```
rotation_degrees = (-45, 20, 0)   # 45° from above, slight angle for shadow depth
light_energy     = 1.2
light_color      = Color(1.0, 0.96, 0.88)  # Warm golden daylight
shadow_enabled   = true
shadow_bias      = 0.05           # Prevent shadow acne on flat terrain
directional_shadow_mode = SHADOW_PARALLEL_4_SPLITS
```

### OmniLight3D (Ambient Fill)
```
light_energy = 0.4
light_color  = Color(0.5, 0.6, 0.8)   # Cool blue fill from "sky bounce"
omni_range   = 100.0                   # Wide enough to cover full map
```

### WorldEnvironment Post-Processing Stack (Desktop/Cinematic Only)
```
# SSAO — depth-aware ambient occlusion
ssao_enabled    = true
ssao_radius     = 1.0
ssao_intensity  = 1.5
ssao_power      = 1.5

# Bloom — cinematic glow on bright areas
glow_enabled       = true
glow_intensity     = 0.4
glow_bloom         = 0.15
glow_hdr_threshold = 0.8

# Depth of Field (Tilt-Shift / Diorama look)
dof_blur_far_enabled    = true
dof_blur_far_distance   = 18.0
dof_blur_far_transition  = 6.0
dof_blur_amount         = 0.08
dof_blur_near_enabled   = true
dof_blur_near_distance  = 2.0
dof_blur_near_transition = 1.5

# Fog (atmospheric depth)
fog_enabled    = true
fog_density    = 0.003
fog_height_min = -5.0
fog_color      = Color(0.7, 0.8, 0.95)

# Color Correction (warm golden-hour grade)
adjustment_enabled       = true
adjustment_brightness    = 1.05
adjustment_contrast      = 1.12
adjustment_saturation    = 1.15
```

For mobile, prefer fakeable atmosphere:

- DOF: foreground masks, depth bands, vignette textures, and art-directed props.
- Fog: mesh planes, 2D gradients, low-count particles, or color ramps.
- Bloom/glow: additive sprites, baked highlights, or limited emissive accents.
- Ambient depth: painted occlusion, baked lighting, and restrained fill lights.

---

## 5. Camera Rig (Isometric Diorama)

### Camera Setup (parented to Player)
```gdscript
# In CameraRig script — attached to Node3D child of Player:
extends Node3D

@export var camera_distance: float = 14.0
@export var camera_height: float = 10.0
@export var camera_angle_deg: float = 45.0   # Octopath uses ~45-55°

func _ready() -> void:
    var cam: Camera3D = $Camera3D
    cam.transform.origin = Vector3(0, camera_height, camera_distance)
    cam.rotation_degrees.x = -camera_angle_deg
    # Slightly narrow FOV for diorama compression effect
    cam.fov = 38.0
```

### Camera Anti-Patterns
- Do not use a single absolute camera rule. Pick from the decision matrix:
  | Goal | Camera |
  |------|--------|
  | Diorama depth / cinematic town | narrow-FOV perspective, usually 35–42° |
  | Readability-first mobile gameplay | orthographic or constrained perspective |
  | Mixed exploration and battle | per-scene camera profile |
  | Low-end fallback | orthographic/constrained perspective with fewer depth effects |
- **Never parent the camera directly to the player root** without a lag interpolation — sudden
  stops look jarring. Use a `Tween` or `lerp()` to smooth follow:
  ```gdscript
  func _physics_process(delta: float) -> void:
      global_position = global_position.lerp(
          get_parent().global_position, delta * 8.0
      )
  ```

---

## 6. Map Marker Placement Rules

### Placement Grid
- All interactable props must snap to a **1.0 unit grid** (use Godot's snap tool with step 1.0).
- Player spawn is always at `Vector3(0, 0, 0)` — offset everything else from this origin.
- Encounter zones use `Area3D` with `CollisionShape3D (BoxShape3D)`. Minimum size: 3×3×3 units.

### Z-Ordering (Sprite3D depth)
- Props closer to the camera (lower Z in world space) must have a **slightly higher Y position**
  (+0.01 per unit of Z difference) to avoid Z-fighting between billboard sprites.
- Example: a guidepost at `z = 5.0` should sit at `y = 0.05`, while one at `z = 10.0` sits at
  `y = 0.0`.

### Prop Type Rules
| Prop Type | Node Type | Billboard | Shadow | Collision |
|-----------|-----------|-----------|--------|-----------|
| Character / NPC | Sprite3D | FIXED_Y | ON | CharacterBody3D |
| Map dressing (tree, rock) | Sprite3D | FIXED_Y | ON | StaticBody3D |
| Healing spring | MeshInstance3D | None | OFF | Area3D (trigger) |
| Encounter zone | Area3D (invisible) | None | OFF | BoxShape3D |
| UI icon marker | Sprite3D | FIXED_Y | OFF | None |

---

## 7. Verification Checklist

- [ ] Scene hierarchy matches required node grouping (Terrain / Props / Encounters / Events).
- [ ] Ground plane uses tiling texture with LINEAR_WITH_MIPMAPS filter.
- [ ] All elevation steps are exactly 0.5-unit multiples.
- [ ] CSGBox3D nodes are flagged for baking before APK export.
- [ ] Grass sway shader only moves top vertices (`UV.y < 0.5` guard).
- [ ] Water shader uses bounded `sin(TIME)` — no unbounded drift.
- [ ] DirectionalLight3D shadow bias = 0.05 (no acne on flat terrain).
- [ ] Desktop/cinematic vs mobile profile chosen before lighting/post-processing.
- [ ] Mobile maps use fake DOF/fog/bloom first; built-in effects are quality-tiered with hardware
      evidence.
- [ ] Camera profile chosen from the matrix; no absolute "never orthographic" rule applied.
- [ ] All map props snap to 1.0-unit grid.
- [ ] Encounter zones are `Area3D` with BoxShape3D (not sphere).
- [ ] No pure-black ambient (fill OmniLight3D present).
