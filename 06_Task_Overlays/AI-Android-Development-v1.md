<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Task Overlay: Repository-Grounded Android Development

**Category:** Task Overlay

**Status:** Active

**Layer:** `06_Task_Overlays`
**Pairs with:** `domain_android_kotlin`

## Activation

Load when a model is generating, reviewing, or modifying Android code.

## Required Grounding

Before proposing code:

1. Read the target project's build files and version catalog.
2. Identify the existing UI, state, navigation, persistence, dependency-injection,
   billing, and testing patterns from source.
3. Treat those observed patterns as project constraints unless the task explicitly
   requests a migration.
4. Verify unstable or time-sensitive platform guidance against current primary
   Android, Kotlin, Gradle, and store documentation.
5. State assumptions when required files or evidence are unavailable.

Do not inject fixed dependency versions, SDK levels, architectural frameworks,
performance targets, or store-policy claims that were not measured or verified for
the target project.

## Generation Contract

- Name the files to change and the project conventions each change preserves.
- Keep domain logic separate from platform, UI, billing, and transport concerns.
- Preserve the project's established state and navigation model.
- Use lifecycle-aware state collection when the observed state type requires it.
- Keep expensive work outside composition and close streams and resources safely.
- Use secure content-sharing APIs; do not expose raw filesystem paths or broad
  storage access without a verified requirement.
- Do not add dependencies, permissions, experimental language features, or
  compiler flags without explicit evidence and scope.

## Review Contract

Review the change against:

- architecture and dependency-boundary consistency;
- lifecycle, state, and configuration-change behavior;
- accessibility semantics and adaptive layout behavior;
- permission, storage, URI-sharing, and sensitive-data handling;
- billing or entitlement state transitions when those surfaces are present;
- deterministic error, empty, loading, and recovery states;
- tests appropriate to the changed contract;
- current build, lint, and test commands declared by the project.

Report findings with file-level evidence. Do not claim performance, policy
compliance, compatibility, or release readiness without the corresponding current
verification.

## Verification

Use the target repository's declared checks. If none are declared, propose a small
measured verification set and label it as an assumption. A successful build alone
does not establish runtime behavior, accessibility, store compliance, or billing
correctness.
