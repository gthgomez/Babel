<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Prompt-Runtime Continuity (v1.0)
**Category:** Governance
**Status:** Active
**Activation:** Load when prompts, example JSON, docs snippets, agent input/output schemas, or demo payloads must stay aligned with a real runtime, API, database, or report contract.

---

## Purpose

Many failures are not code bugs.

They are continuity bugs:

- a prompt expects the wrong field name
- an example payload flattens a nested contract
- a docs snippet implies a shape the runtime never emits
- an agent output schema drifts from the actual parser or report format

This skill exists to catch those mismatches before they turn into broken prompts, stale examples, or false product claims.

---

## Step 1 — IDENTIFY THE AUTHORITY SURFACE

Choose the real source of truth first:

- runtime code
- schema / types
- migration
- parser / validator
- versioned public contract

Then list the derivative surfaces:

- prompts
- example JSON
- README snippets
- sales or demo payloads
- UI mock payloads

If there is no clear authority surface, say the contract is undefined instead of guessing.

---

## Step 2 — RUN THE FIELD-LEVEL CONTINUITY CHECK

Compare authority vs derivative surfaces for:

- field names
- nesting
- required vs optional
- enum values
- semantic meaning
- example value shape

Explicitly check for these drift patterns:

- renamed fields still used in prompts
- flattened fields that are nested in the real contract
- top-level counts that actually live under `summary`
- example arrays whose semantics differ from runtime arrays
- prompt instructions that require fields not present in the real payload

---

## Step 3 — DECLARE THE TRANSFORM BOUNDARY

If the derivative surface differs intentionally, the transform must be explicit.

Allowed:
- "The prompt consumes normalized JSON after `transformScannerReport()`"
- "The README example is simplified and labeled as illustrative, not literal runtime output"

Not allowed:
- silent schema drift
- example payloads presented as real outputs when they are not
- prompts that assume a transform no one named

If no transform exists, the derivative surface should match the authority surface directly.

---

## Step 4 — CLASSIFY THE CONTINUITY RISK

Use one of:

- `ALIGNED` — derivative surface matches the authority contract
- `DRIFTED` — mismatch exists and can mislead humans or models
- `INTENTIONAL_TRANSFORM` — mismatch exists but is explicit and bounded

If the authority contract itself must change, hand off to `skill_bcdp_contracts` instead of patching the examples only.

---

## Step 5 — REPAIR IN THE RIGHT DIRECTION

Preferred repair order:

1. align prompts/examples/docs down to the real contract
2. if a normalized view is needed, add or document the transform explicitly
3. only then change the runtime contract, with BCDP discipline

Do not "fix" drift by making the example more vague.

---

## Recommended Output Shape

1. authority surface
2. derivative surfaces checked
3. drift found
4. chosen repair
5. migration note if any consumer must change

---

## Hard Rules

1. Never let a prompt or example invent fields the real contract does not provide.
2. Never flatten or rename fields across a boundary unless the transform is explicit.
3. Example output is part of the interface; a stale example is a contract bug.
4. A mock payload in docs or UI is not proof that the runtime emits the same shape.
5. If humans or models will copy the example, treat it as production-facing contract material.
