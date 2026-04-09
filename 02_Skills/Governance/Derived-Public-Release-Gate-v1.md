<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Derived Public Release Gate (v1.0)
**Category:** Governance
**Status:** Active
**Activation:** Load when the target push is a public-facing repo derived from a private source-of-truth repo, especially when the task involves release prep, scrub checks, or deciding whether a private change is safe to publish.

---

## Purpose

Public release from a paired private/public system is not a normal push.

This skill forces the model to step back and answer:

- is this content actually public-safe?
- is this repo the derived public surface or the private source repo?
- did the export/scrub workflow run, or are we about to publish too much?

---

## Step 1 — REQUIRE A PUBLIC RELEASE DECISION

Before touching GitHub:

1. identify the target repo as `public_derived`
2. classify the touched content with `docs/SURFACE_CLASSIFICATION_GATE.md`
3. split it into:
   - `public_safe`
   - `sanitize_and_export`
   - `private_only`

If any touched item is `private_only`, it must not ship to the public repo.

---

## Step 2 — ROUTE THROUGH THE DERIVED-REPO WORKFLOW

For Babel, load and follow:

- `REPO_ROLE.md`
- `docs/PUBLIC_EXPORT_REPO_ROLE.md`
- `docs/PRIVATE_TO_PUBLIC_WORKFLOW.md`
- `docs/PUBLIC_REPO_SANITIZATION_RULES.md`
- `docs/PUBLIC_EXPORT_CHECKLIST.md`

If the task is “publish Babel,” the default assumption is:

- author in `Babel-private`
- export or sanitize intentionally
- validate in `Babel-public`
- push only the derived public tree

---

## Step 3 — PROVE THE PUBLIC PUSH IS SAFE

Before the public push, require:

1. exact exported/staged path list
2. explicit statement of what stayed private
3. scrub validation
4. release validation

For Babel, use:

- `tools/check-public-scrub.ps1`
- `tools/validate-public-release.ps1`

If those checks are not run on the public tree, the release is not ready.

---

## Step 4 — BIAS TOWARD UNDER-RELEASE

If unsure whether a file belongs in public:

- keep it private
- convert it to a sanitized example later if needed

The failure mode to avoid is publishing too much, not publishing too little.

---

## Hard Rules

1. Never treat a public-derived release like an ordinary repo push.
2. Never publish directly from the private source repo when a derived public repo exists.
3. Never push to the public repo until the content is classified and scrub-validated.
4. Never let “already in the local tree” count as proof that a file is public-safe.
5. When unsure, keep it in the private repo and release a smaller public surface.
