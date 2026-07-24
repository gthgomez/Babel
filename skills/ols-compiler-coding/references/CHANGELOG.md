# OLS Compiler Coding Variant — Changelog

All notable changes to the ols-compiler-coding skill are documented here.

## [v1.0.0] - 2026-06-27

### Initial Release

Built on ols-compiler v4.5.1 hardened architecture. Inherits all base behavior (Authority Order, orthogonal THINKING_DEPTH/OUTPUT_DETAIL axes, non-negotiable safety overrides, Verdict Gates, Evidence Labels, Delivery Patterns).

### Added

- **SKILL.md**: Lean activation/router layer. Defers all base behavior to `skills/ols-compiler/references/ols-mcc-v4.5.md`.
- **Code Review Module**: Four review depth tiers (Quick Scan → Standard → Deep Audit → Production Gate). Compiled prompt structure with severity-categorized findings.
- **Test Generation Module**: Four test depth tiers (Unit → Module → Feature → Regression). Framework-aware test compilation targeting project conventions.
- **Refactoring Compilation Module**: Hard constraints on behavioral preservation, scope boundaries, and refactor-locked code categories.
- **PR Review Automation Module**: Full PR review output format with severity matrix, test coverage analysis, breaking change detection, and GO/NO-GO verdict.
- **Language-Specific Nuances Module**: Six initial languages — TypeScript/JavaScript, Python, Kotlin (Android), Swift (iOS), GDScript (Godot 4.x), C++ (JNI/NDK/Emulator). Each with type system rules, framework conventions, common antipatterns, and test framework defaults.
- **BLUE Verdict Gate**: Coding-specific gate requiring validation against real code with measured outcomes.
- **Module Combination Rules**: Compatibility matrix ensuring safe module stacking.
- **Self-Application Rules**: Inherited from base compiler v4.5.1 with identical strict conditions.

### Design Decisions

- Coding variant as a separate skill rather than a module inside the general compiler. Rationale: the general compiler handles structure (prompt architecture); the coding variant handles content (code-specific patterns). Keeping them separate prevents bloat in either.
- Language nuances included directly rather than as separate per-language files. Rationale: the nuances are concise (~15 lines each), and having them in one place makes cross-language comparison and addition easy.
- PR Review as a distinct module from Code Review. Rationale: PR review includes scope matching, BCDP analysis, migration safety, and dependency auditing that code review alone doesn't cover.
