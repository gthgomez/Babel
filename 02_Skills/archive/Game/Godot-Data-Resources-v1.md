<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Godot Data & Resources (v1.1)

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
