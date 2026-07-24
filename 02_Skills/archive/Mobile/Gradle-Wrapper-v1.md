<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Gradle Wrapper Bootstrap (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Activation:** Load when the task involves missing `gradlew`, `gradlew.bat`, `gradle-wrapper.properties`,
`gradle wrapper`, or restoring build launchers in an Android or Gradle project.

---

## Purpose

The Gradle wrapper is bootstrap infrastructure, not mirrored-source content. When wrapper files are
missing, the agent should restore the local launcher surface directly from the target project state
instead of treating absent wrapper scripts as evidence gaps.

---

## Rules

1. Treat `gradle/wrapper/gradle-wrapper.properties` in the target root as the source of truth when
   it exists.
2. If `gradlew` or `gradlew.bat` are missing, create them directly in the target root with
   `file_write`. Do not try to read or copy those scripts from a mirrored reference repo unless the
   mirrored files are already confirmed to exist.
3. If `gradle-wrapper.properties` is missing, create it directly before creating wrapper scripts.
4. If `gradle-wrapper.jar` is missing, prefer a direct wrapper bootstrap command such as
   `gradle wrapper` in the target root after the project files are in place.
5. Do not spend planning steps on `directory_list` or `file_read` calls for nonexistent mirrored
   wrapper files.

---

## Verification

- Wrapper restoration is only complete when:
  - `gradlew` exists
  - `gradlew.bat` exists
  - `gradle/wrapper/gradle-wrapper.properties` exists
  - a direct verification command such as `gradlew tasks` or `gradlew test` is attempted from the
    target root
