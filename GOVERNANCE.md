<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Governance

## Purpose

This document defines how Babel should evolve without turning into prompt sprawl.

## Core Principles

1. Keep the system layered.
2. Keep general rules general.
3. Prefer additive overlays over new top-level roles.
4. Treat routing and behavioral changes as high-risk system changes.
5. Keep the catalog as the source of truth for routable assets.

## Change Hierarchy

Highest risk:
- `00_System_Router/`
- `01_Behavioral_OS/`
- `prompt_catalog.yaml`

Medium risk:
- `02_Domain_Architects/`
- `03_Model_Adapters/`

Lower risk:
- `05_Project_Overlays/`
- `06_Task_Overlays/`

## Prompt / Runtime Contract Co-evolution

Babel's model contracts live in two places per stage:

1. the prompt file
2. the runtime task builder in `babel-cli/src/`

If a runtime change adds a model-facing field, enum, or required behavior, the corresponding prompt file must be updated in the same change set.

## Catalog Integrity

At minimum:

- every `path:` exists
- every ID is unique
- deprecated entries are labeled clearly
- new routable files are registered

## Public Repo Note

Public docs should prefer relative links and public-safe example identifiers.
