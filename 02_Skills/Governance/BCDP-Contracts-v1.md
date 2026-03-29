<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Breaking Change Detection Protocol (BCDP) — v1.0

**Category:** Governance
**Status:** Active
**Pairs with:** `domain_swe_backend`, `domain_swe_frontend`, `domain_devops`

---

## Purpose

Before proposing any change to a contract — API shape, database schema, shared interface, component props, or environment variable — you must classify the impact and provide the appropriate safety artifacts. This skill is the enforcement layer for that requirement.

A contract is any interface consumed by code you did not write in this task, or that exists across a service boundary.

---

## Step 1: Identify All Known Consumers

For every contract you intend to change, list:
- Which files, services, or components read or write this interface
- Whether the consumer is in-repo (can be updated atomically) or external (cannot be updated atomically)
- Whether downstream consumers are known-exhaustive or potentially incomplete

If consumer identification is incomplete, state that explicitly before proceeding. Do not assume the list is exhaustive.

**When `skill_evidence_gathering` is also loaded:** The Consumer Index from Evidence Gathering Step 3
is already this list. Do not re-enumerate. Take that table as input and proceed directly to Step 2
(impact classification).

---

## Step 2: Classify the Impact

Assign exactly one label to the proposed change:

| Label | Definition |
|-------|-----------|
| `COMPATIBLE` | Additive only. Existing consumers continue to work without modification. Example: adding an optional field to a response. |
| `RISKY` | Existing consumers may break depending on how they handle the change. Requires verification of each known consumer. Example: renaming a field, changing a type from `string` to `string \| null`. |
| `BREAKING` | Existing consumers will break. Atomic update of all consumers is required, or a migration bridge must be implemented first. Example: removing a required field, changing a primary key type. |

Default to `RISKY` when uncertain between `COMPATIBLE` and `RISKY`.
Default to `BREAKING` when uncertain between `RISKY` and `BREAKING`.
Never self-classify a change as `COMPATIBLE` to skip the safety artifacts.

---

## Step 3: Required Artifacts by Classification

### COMPATIBLE
- State the classification and which consumers were checked.
- No migration steps required.

### RISKY
- List every known consumer and whether it needs updating.
- Provide a verification plan: how you will confirm no consumer is broken after the change.
- Identify any consumer you cannot update atomically and explain the gap.

### BREAKING
- List every known consumer and the exact change required in each.
- Provide a migration bridge if all consumers cannot be updated in the same deployment:
  - What the bridge is (dual-write, versioned endpoint, feature flag, etc.)
  - When the bridge is removed
- Provide a rollback strategy:
  - What state needs to be restored
  - Whether data migration is reversible
  - Which deployment step triggers rollback eligibility
- Explicitly state whether this change is safe to deploy independently or requires a coordinated release.

---

## Contract Types and Common Failure Patterns

### API / Edge Function Response Shape
- Adding a required field to a response → `RISKY` (clients may not expect it)
- Removing any field → `BREAKING`
- Changing a field's type → `BREAKING`
- Adding an optional field → `COMPATIBLE`

### Database Schema
- Adding a nullable column → `COMPATIBLE`
- Adding a NOT NULL column without a default → `BREAKING`
- Renaming a column → `BREAKING`
- Changing a column type → `BREAKING` (even widening, e.g. `int` → `bigint` with ORM)
- Adding an index → `COMPATIBLE`
- Dropping a column → `BREAKING`
- Changing RLS policies → treat as `RISKY` minimum; audit all affected query paths

### TypeScript Interfaces / Zod Schemas
- Adding optional property → `COMPATIBLE`
- Adding required property → `BREAKING` for all callers that construct the type
- Narrowing a property type → `BREAKING`
- Widening a property type → `RISKY` (callers may rely on the narrower type)
- Renaming a property → `BREAKING`

### Component Props (Frontend)
- Adding optional prop with default → `COMPATIBLE`
- Adding required prop → `BREAKING`
- Removing any prop → `BREAKING`
- Changing a prop's type → `BREAKING`

### Environment Variables
- Adding a new required env var → `BREAKING` for any deployment without it
- Renaming an env var → `BREAKING`
- Removing an env var → verify all consumers before classifying

---

## Hard Rules

1. Never skip Step 1 because the consumer list "seems obvious."
2. Never output a migration plan that says "update all callers" without listing them.
3. Never classify a schema column rename or removal as `COMPATIBLE` or `RISKY`.
4. If a BREAKING change has no rollback strategy, the plan is incomplete — do not mark it ready for execution.
5. For external consumers (third-party integrations, webhooks, published SDKs), treat every change as `BREAKING` until proven otherwise.
