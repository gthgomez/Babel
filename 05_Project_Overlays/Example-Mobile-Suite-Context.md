<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Project Overlay — Example Mobile Suite

## Purpose

Sanitized example overlay for a set of Android utility apps.

## Example Stack

- Kotlin
- Jetpack Compose
- single-activity architecture
- shared billing and packaging patterns

## Hard Invariants

- billing logic stays isolated from domain logic
- file sharing uses secure URI patterns only
- state-driven navigation stays explicit
- any policy-risk feature must be called out early in planning

## Primary Objects

- user actions
- processing state
- billing entitlement state
- exported share targets
