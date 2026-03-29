<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# 06_Task_Overlays

## Purpose

Optional overlays for bounded task types.

These are loaded after the project overlay and before pipeline stages.

## Why This Layer Exists

Some tasks need extra guidance that is:
- more specific than a domain architect
- more reusable than a single project prompt
- not important enough to justify a new domain role

Task overlays solve that problem.

## Rules

1. Task overlays are optional.
2. They must not weaken Behavioral OS rules.
3. They must not replace the primary domain architect.
4. They should be small, focused, and clearly scoped.
5. Prefer a generic reusable overlay plus a project-specific delta when possible.

## Current Intended Pattern

- generic reusable overlay
- optional project-specific task overlay

Example:
- `Frontend-Professionalism-v1.0.md`
- `Example-SaaS-Backend-Frontend-Professionalism-v1.0.md`

