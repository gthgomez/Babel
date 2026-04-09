<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Public Export Hardening (v1.0)
**Category:** Governance
**Status:** Active
**Activation:** Load when preparing content from a private source repo for a derived public repo, especially when the task includes sanitization, example-overlay replacement, public scrub validation, or release-readiness review.

---

## Purpose

Public export is not "delete anything sensitive until it looks clean."

For Babel, the correct model is:

- private repo stays source-of-truth
- public repo is a derived export
- private identifiers are replaced intentionally, not mass-scrubbed blindly
- public validation is run inside the exported tree before release

This skill exists to route that workflow through the existing Babel docs and tools instead of re-inventing the checklist every time.

It assumes repo targeting has already been checked. If the task is ambiguous about whether the push target is the private source repo or the derived public repo, resolve that first.

---

## Read This First

Load only the repo-role, export-workflow, release-checklist, and surface-classification docs needed for the current step.

Use these tools, not ad hoc copy/scrub flows:

- `tools/export-babel-public.ps1`
- `tools/check-public-scrub.ps1`
- `tools/validate-public-release.ps1`

---

## Workflow

### Step 1 — CLASSIFY THE SURFACE

Before editing, classify each touched artifact:

| Class | Meaning |
|-------|---------|
| `public_safe` | can ship as-is |
| `sanitize_and_export` | can ship only after replacement/generalization |
| `private_only` | must not leave the private repo |

**Rule:** If the correct action is "keep private," do not invent a sanitized public version unless the task explicitly needs one.

### Step 2 — EXPORT, DO NOT MASS-SCRUB

Preferred path:

1. improve the private source intentionally
2. export through `tools/export-babel-public.ps1`
3. let the export pipeline perform the replacement rules
4. harden the public tree afterward only where needed

**Rule:** Do not use sanitization rules as permission to rewrite `private source repo` into a pseudo-public repo.

### Step 3 — REVIEW THE HIGH-RISK PUBLIC SURFACES

Manual review targets:

- `prompt_catalog.yaml`
- project overlays and example overlays
- orchestrator examples and project IDs
- `README.md`, onboarding docs, and example manifests
- fixtures and tests that might still name private projects or local paths

### Step 4 — VALIDATE THE EXPORTED TREE

Minimum validation:

1. `tools/check-public-scrub.ps1`
2. `tools/validate-public-release.ps1`
3. deterministic preview checks against the repo's checked-in public manifest examples

If validation is not run, the export is not release-ready.

---

## Hard Rules

1. Never mass-scrub the private source repo to make it publishable.
2. Never publish private overlays, local paths, live deployment URLs, or private project/product identifiers.
3. Never treat the public export as clean without running scrub and release validation in the exported tree.
4. Never keep private IDs in `prompt_catalog.yaml` examples or public manifest previews.
5. If a document or tool is dual-use but still private-fingerprinted, classify it as `sanitize_and_export`, not `public_safe`.
6. Never let a private-source repo keep pushing to a public remote after a repo-role mismatch is discovered.
