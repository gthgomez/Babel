<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Project Overlay — Example SaaS Backend

## Purpose

Sanitized example overlay for a compliance-focused SaaS backend.

## Example Stack

- TypeScript backend and admin frontend
- Postgres-backed persistence
- serverless API and webhook handlers
- subscription billing

## Hard Invariants

- fail closed on policy-sensitive decisions
- preserve tenant isolation and boundary checks
- keep enforcement deterministic and evidence-oriented
- avoid vague AI-first product framing when the surface is operational

## Primary Objects

- organizations
- policies
- evidence records
- billing events
