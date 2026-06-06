<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# HD-2D Sprite Pipeline (v1.1)

**Category:** Game / Art
**Status:** Active
**Last Verified:** 2026-04-29
**Engine Target:** Godot 4.6 (Sprite3D + StandardMaterial3D + AnimationPlayer)
**Reference Style:** Octopath Traveler, Triangle Strategy (Square Enix HD-2D)

## Purpose

This skill governs the full pipeline for creating, lighting, and integrating HD-2D sprites into a
Godot 3D diorama scene. It covers pixel art authoring rules, normal map generation, animation
frame standards, lit material setup, and Godot-side import settings.

The goal is sprites that feel like they *belong* in the 3D world — receiving light, casting
shadows, and animating with cinematic weight — rather than sprites pasted on top of a 3D scene.

---

## 1. Pixel Art Authoring Rules

### Resolution & Canvas
- **Character sprites:** 32×48 px (portrait) or 48×48 px (square fighters). Scale by 4× in
  Godot via `pixel_size` on `Sprite3D` to reach HD clarity.
- **Monster sprites:** Scale relative to player. Use 48×48 (regular), 64×64 (boss), 96×64
  (wide boss). Never exceed 128×128 for mobile performance.
- **Map props (guidepost, spring, lamp):** 24×32 to 32×32 px canvas.
- **UI icons:** 16×16 canonical pixel art, displayed at 2× or 4× via Godot's
  `texture_filter = NEAREST` to preserve pixel crispness.

### Color Palette
- **Max 24 colors per sprite** (Octopath standard). Use a shared "world palette" `.gpl` file
  to ensure sprites cohere with environment tones.
- **No pure black outlines.** Use dark-hued outlines: dark navy for neutral characters, dark
  maroon for fire types, dark forest green for nature types. Pure black looks flat under 3D
  lighting.
- **Rim color:** Reserve 1–2 colors for the brightest specular highlight (`near-white` or
  `pale gold`). This is the pixel that "catches the light."

### Shading Technique
- Use **3-value shading** (base, shadow, highlight) for standard areas.
- Use **dithering** (50% checkerboard) on transition zones between shadow and midtone for
  a soft gradient without extra colors. This is Octopath's signature look.
- Apply a **second inner shadow** (1px darker, 1px inset) at the top of any rounded form
  (head, shoulder) to read well under the scene's top-down directional light.

---

## 2. Animation Standards (Walk Cycles & Actions)

### Walk Cycle — 8 Frames
Octopath-quality walk cycles use 8 frames at 12 FPS:

| Frame | Description                          | Vertical Offset |
|-------|--------------------------------------|-----------------|
| 1     | Contact (left foot forward)          | 0 px            |
| 2     | Recoil (weight settling)             | +1 px (down)    |
| 3     | Passing (feet crossing)              | 0 px            |
| 4     | High (foot lifting)                  | -1 px (up)      |
| 5     | Contact (right foot forward)         | 0 px            |
| 6     | Recoil                               | +1 px (down)    |
| 7     | Passing                              | 0 px            |
| 8     | High                                 | -1 px (up)      |

The 1–2 px vertical bounce is the key differentiator between "stiff" and "alive" HD-2D walk
cycles.

### Idle Animation — 4 Frames at 6 FPS
Frames: Neutral → +1px down (breathe in) → +1px down (hold) → Neutral (breathe out).
Add a subtle 1px horizontal sway on frames 2–3 for personality.

### Attack / Action — 6 Frames at 18 FPS
Use "anticipation → blur → impact → recoil → settle" structure. The "blur" frame can be a
motion-smear (stretch the sprite 1px horizontally or use a ghost afterimage in a separate layer).

### Sprite Sheet Layout
- All directions in a single sheet: Down (row 0), Left (row 1), Right (row 2), Up (row 3).
- Idle frames precede walk frames in the same row.
- Export transparent sprites as **PNG** and keep PNG as the production source for alpha art.
- Use **JPG** only for opaque backgrounds or intentionally opaque art. JPG destroys alpha and is
  not valid for character, prop, foliage, or icon sprites that need transparency.
- **Sheet dimensions must be power-of-two** (512×512, 1024×512, etc.) for GPU texture
  compatibility on Android.

---

## 3. Normal Map Generation

Normal maps are part of the medium/high HD-2D lighting profile. On mobile, make normal maps and
per-pixel lighting quality-tiered instead of mandatory on every sprite.

### Tooling Options (ranked)
1. **Laigter (free, open-source):** Best results for pixel art. Drag PNG in, adjust depth/height,
   export `_normal.png`. One normal map per sprite sheet.
2. **Sprite Illuminator (paid):** More control over specular intensity per zone.
3. **Aseprite + Normal Map extension (free):** Generates normals from a depth-paint layer you
   draw manually. Most accurate for non-organic shapes (shields, armor).

### Normal Map Rules
- Keep normal map at **same resolution** as the source sprite PNG (do not upscale).
- The X channel (R) should point right, Y channel (G) up, Z channel (B) toward the camera —
  this is OpenGL convention, which Godot uses natively.
- Apply the normal map as `StandardMaterial3D.normal_texture` on the `Sprite3D`'s material for
  key characters, enemies, and hero props in tiers that can afford per-pixel lighting.
- Set `normal_scale = 0.8` (not 1.0). Full strength washes out the artist's painted shading.

---

## 4. Godot Import & Material Setup

### Sprite3D Configuration
```gdscript
# In the Sprite3D Inspector:
texture             = preload("res://assets/characters/player_sheet.png")
normal_map          = preload("res://assets/characters/player_sheet_normal.png")
pixel_size          = 0.008          # Tune per scene scale
billboard           = BaseMaterial3D.BILLBOARD_FIXED_Y  # Y-Billboard only
double_sided        = true
alpha_cut           = BaseMaterial3D.ALPHA_CUT_DISCARD
alpha_scissor_threshold = 0.5        # Crisp pixel alpha; tune per sprite sheet
texture_filter      = BaseMaterial3D.TEXTURE_FILTER_NEAREST  # Preserve pixel crispness
shading_mode        = BaseMaterial3D.SHADING_MODE_PER_PIXEL  # Medium/high lit tier
shadow_casting_mode = GeometryInstance3D.SHADOW_CASTING_MODE_ON
```

### Alpha And Overdraw

- Use Alpha Scissor for crisp character, prop, and UI-like billboard silhouettes.
- Use Alpha Hash only for foliage or soft alpha where dithering artifacts are acceptable after
  device testing.
- Prefer tighter sprite bounds and atlases over large transparent sheets that increase overdraw.
- Disable shadows and per-pixel lighting on low-priority background sprites when profiling shows
  Sprite3D overdraw or material cost.

### Anti-Patterns
- **Never use `BILLBOARD_ENABLED` (full billboard):** Sprites will rotate to always face camera,
  losing the isometric "standing on the ground" feel. Always use `BILLBOARD_FIXED_Y`.
- **Do not force per-pixel lighting on every mobile sprite:** Key actors should receive the
  strongest lit treatment, but low-tier/background sprites may use cheaper materials when the
  quality tier documents the tradeoff.
- **Never import as JPG for character sprites that have transparency:** Use PNG source, let
  Godot convert. JPG destroys alpha; use only for opaque backgrounds.

### Optional Hybrid 2D/3D Sprite Extensions

Treat Hybrid 2D/3D Sprite GDExtension-style plugins as optional/prototype aids until Android/iOS
export binaries and project compatibility are verified. Always keep a Sprite3D fallback path.

### AnimationPlayer Wiring
```gdscript
# In AnimationPlayer, drive Sprite3D region_rect to switch frames:
# Track type: Property, Node: Sprite3D, Property: region_rect
# Key at frame 0: Rect2(0,   0, 48, 48)  # row 0, col 0
# Key at frame 1: Rect2(48,  0, 48, 48)  # row 0, col 1
# etc.

# In PlayerController.gd, switch animation based on direction:
func _update_animation(velocity: Vector3) -> void:
    if velocity.length() < 0.1:
        %Sprite3D.get_node("AnimationPlayer").play("idle_down")
        return
    var angle := atan2(velocity.x, velocity.z)
    if abs(angle) < PI / 4.0:
        %Sprite3D.get_node("AnimationPlayer").play("walk_down")
    elif abs(angle) > 3.0 * PI / 4.0:
        %Sprite3D.get_node("AnimationPlayer").play("walk_up")
    elif angle > 0:
        %Sprite3D.get_node("AnimationPlayer").play("walk_right")
    else:
        %Sprite3D.get_node("AnimationPlayer").play("walk_left")
```

---

## 5. UI Sprite Rules

### Icon Sheets
- 16×16 px per icon, 8 icons per row, up to 4 rows per sheet (128×64 px total).
- Use the **Prentice-adjacent** font **Cormorant Garamond** (free, Google Fonts) for all
  in-game text labels on UI. Set `texture_filter = NEAREST` on all icon textures.
- **Color-code icon borders** by category: Gold border = equipment, Blue = consumable,
  Red = key item, Green = passive skill.

### Ornate Frame Pattern
- The UI panel frame is a **NinePatchRect** with 3 regions: corner ornament, side bar, center.
- Corner ornament: 24×24 px pixel art of a stylized gold leaf or filigree knot.
- Side bar: 1×8 px tiling stripe (dark wood grain or dark leather texture).
- Center: solid semi-transparent dark (`Color(0.05, 0.03, 0.07, 0.88)`).

---

## 6. Verification Checklist

- [ ] All sprite sheets are power-of-two dimensions.
- [ ] Walk cycle has 8 frames with correct vertical offset per frame.
- [ ] Normal map exported at same resolution as source PNG (OpenGL convention).
- [ ] `Sprite3D.billboard = BILLBOARD_FIXED_Y` (never full billboard).
- [ ] Transparent sprites remain PNG; JPG is limited to opaque art.
- [ ] Alpha Scissor/Alpha Hash choice is deliberate and checked for overdraw.
- [ ] Normal maps, per-pixel lighting, and shadows are assigned by quality tier.
- [ ] `texture_filter = NEAREST` (preserves pixel crispness).
- [ ] AnimationPlayer drives `region_rect`, not `texture` swapping.
- [ ] No pure black outlines in the sprite palette.
- [ ] `.import` files are valid and exported Android texture payloads are present.
- [ ] Mobile APK tested — sprite reads clearly at 360p and 1080p.
