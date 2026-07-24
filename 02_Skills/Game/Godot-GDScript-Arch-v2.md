<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Godot GDScript & Architecture (v2.0)

**Category:** Game
**Status:** Active
**Last Verified:** 2026-04-25

## Purpose
This skill provides architectural guidance for Godot 4.6 stable game development using GDScript 2.0. It prioritizes decoupling, performance, and maintainability.

## Rules
1. **Composition Over Inheritance**: Avoid deep inheritance trees. Use child nodes and scenes as components (e.g., `HealthComponent`, `HitboxComponent`).
2. **Call Down, Signal Up**:
   - **Call Down**: Parents call methods on children.
   - **Signal Up**: Children emit signals; parents (or event buses) connect to them. Children must never know their parent's type.
3. **Static Typing**: Always use type hints (e.g., `var health: float = 100.0`, `func _on_damage(amount: int) -> void`). Use `--warn-untouched-function-return` and `--warn-missing-type-hints`.
4. **Scene Unique Nodes**: Use `%NodeName` for frequently accessed child nodes to decouple scripts from exact scene tree paths.
5. **Signal Bus (Global)**: Use a `SignalBus` autoload for cross-system events (e.g., `game_over`, `player_spawned`). Do not use it for local parent-child communication.
6. **Node Lifecycle**: Use `_ready()` for initialization. Use `_process(delta)` for per-frame logic and `_physics_process(delta)` for physics and movement.
7. **Typed Arrays**: Use typed arrays (e.g., `Array[Tower]`) for performance and autocomplete.

## Anti-Patterns
- Using `get_parent().get_parent()` to access distant nodes.
- Putting business logic (damage calculation, AI) directly in UI scripts.
- Hardcoding node paths as strings (e.g., `get_node("UI/HUD/Label")`).
- Excessive use of singletons/autoloads for non-global state.

## Verification
- Run `Project -> Tools -> GDScript -> Check Project Types`.
- Verify no errors in the "Output" tab during scene transitions.
- Confirm all signals are connected in the "Node" tab.

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
