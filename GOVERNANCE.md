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

## Creation Policy

Before adding a new Babel file, check:
- can this be handled by an existing file?
- should this be a task overlay instead of a new domain role?
- is this rule reusable across projects?
- will the catalog and router need updates?

If a new file is added, keep the delta explicit.

## Review Policy

Changes should be reviewed for:
- layer correctness
- duplication
- dead references
- portability assumptions
- whether a weaker layer is trying to override a stronger layer

## Catalog Integrity

The catalog must remain internally valid.

At minimum:
- every `path:` exists
- every ID is unique
- deprecated entries are marked clearly
- new routable files are registered

## Public Repo Note

GitHub-facing docs should prefer relative links.
Runtime/orchestrator contracts may continue to use Windows-first absolute paths if that remains the intended local execution environment.
