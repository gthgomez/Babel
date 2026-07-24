---
name: android-testing-strategy
description: Add, modify, or review Android tests by routing to the correct JVM unit, instrumented, or screenshot test surface; use for ViewModel state patterns, Android framework dependencies, Gradle/AGP screenshot setup, and device-availability constraints.
---

## Prompt bridge

- **Babel catalog id:** `skill_android_testing_strategy`
- **Prompt-layer owner:** `02_Skills/Mobile/Android-Testing-Strategy-v1.md`
- Use the prompt skill for Babel stack assembly; use this package for structured contracts, examples, and validation fixtures.

# Android Testing Strategy

Use this skill when adding, modifying, or reviewing Android tests. It routes work to the
right test surface before implementation: JVM unit tests, instrumented Android tests,
or screenshot/visual tests.

## Routing Workflow

1. Read the class under test before choosing a test type.
2. If it imports Android framework APIs such as `android.*`, prefer `src/androidTest/`.
3. If it is pure Kotlin or a ViewModel without Android framework dependencies, prefer `src/test/`.
4. If it renders Compose UI or needs visual regression coverage, use the repo's screenshot test setup.
5. Check ViewModel state type before choosing Flow/Turbine patterns.
6. Check Gradle/AGP setup before adding screenshot plugins or dependencies.

## ViewModel Checks

- `mutableStateOf`: assert state directly after scheduler advancement or helper waits.
- `StateFlow`: use Flow/Turbine-style emission assertions if the repo already uses them.
- Explicit `Dispatchers.IO` or `Dispatchers.Default`: account for real-thread dispatch in tests.

## Device Constraints

- If no emulator/device is available, compile instrumented tests and state the skipped execution.
- Do not let missing device infrastructure block JVM unit or screenshot tests.

## Verification Output

Include:

```text
TEST ENFORCEMENT
Behavior surfaces changed: [...]
Required test classes: [...]
CI commands to run: [...]
Skipped verification: none | reason
```

## Hard Rules

- Do not put pure Kotlin tests in `androidTest/`.
- Do not use Turbine for `mutableStateOf`.
- Do not add screenshot tooling without checking the existing Gradle/AGP pattern.
- Do not claim connected tests ran unless a device/emulator actually executed them.
