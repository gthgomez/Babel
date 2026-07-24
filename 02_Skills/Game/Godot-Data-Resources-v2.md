<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Godot Data & Resources (v2.0)

**Category:** Game
**Status:** Active
**Last Verified:** 2026-04-25

## Purpose
Enforces data-driven design using Godot's powerful `Resource` system for game state, item data, and configuration.

## Rules
1. **Custom Resources**: Inherit from `Resource` for data structures (e.g., `class_name TowerData extends Resource`). Avoid using large dictionaries or JSON files for static game data.
2. **Exported Resources**: Use `@export var data: TowerData` to assign data to nodes in the editor. This allows designers to swap data without touching code.
3. **Save/Load Logic**: Use `ResourceSaver.save(data, path)` and `SafeResourceLoader.load(path)` for saving/loading user state. 
4. **Immutability (Base Data)**: Base game data resources (e.g., `base_tower_stats.tres`) should be treated as read-only at runtime. `duplicate()` them if unique instance state is needed.
5. **Resource Tooling**: Use `@tool` scripts for simple editor-time visualization or validation. For complex custom inspectors, docks, import workflows, or editor UI, create an `EditorPlugin` instead.
6. **Binary vs Text**: Use `.tres` (text) for git-friendly development and `.res` (binary) for production builds if performance/size is critical.
7. **Preloading**: Use `preload()` for resources needed immediately on scene load and `load()` or `ResourceLoader.load_threaded_request()` for async loading of heavy assets.

## Anti-Patterns
- Storing game-wide stats (XP, level) in a global script without a backing `Resource`.
- Manually parsing JSON for simple game items that could be `.tres` files.
- Modifying shared resource instances without `duplicate()`, causing "spooky action at a distance."

## Verification
- Verify that `.tres` files are human-readable and git-diffable.
- Confirm that `save_game.tres` is correctly generated in `user://` path.
- Validate that `@export` resources are assigned in the inspector for all relevant scenes.

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
