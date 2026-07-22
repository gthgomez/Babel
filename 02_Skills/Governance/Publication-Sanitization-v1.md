<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Publication Sanitization (v1.0)
**Category:** Governance
**Status:** Active
**Activation:** Load when a project publishes a selected content surface to a separate publication target and the task includes sanitization, example replacement, content-policy validation, or release-readiness review.

---

## Purpose

Publication sanitization is a controlled transformation, not an unrestricted text scrub.
Use the target project's documented publication workflow to preserve intended public behavior
while excluding non-public identifiers, machine-local details, credentials, and unsupported claims.

If the repository being changed is itself authoritative, commit reviewed source changes directly;
do not invent a separate publication workflow.

---

## Step 1 — CLASSIFY THE SURFACE

Classify each touched artifact with one of these neutral values:

| Class | Meaning |
|-------|---------|
| `publish_as_is` | Approved for the publication target without transformation |
| `transform_before_publication` | Requires replacement, generalization, or redaction |
| `retain_in_authoritative_repo` | Must not enter the publication target |

When classification is uncertain, record the uncertainty and keep the artifact out of the
publication set until an owner resolves it.

---

## Step 2 — USE THE DECLARED PUBLICATION WORKFLOW

1. Identify the authoritative repository and publication target.
2. Use the project's declared transformation or selection mechanism.
3. Apply documented replacement rules deterministically.
4. Review the resulting publication tree, not only the source diff.

If no declared workflow exists, stop publication and define the contract first.

---

## Step 3 — REVIEW HIGH-RISK SURFACES

Review catalogs, routing examples, project identifiers, onboarding documents, fixtures,
machine paths, deployment URLs, prompt policy files, and generated manifests.

Do not print prohibited terms or sensitive source lines in logs. Report category, path, and
line number unless an authorized local review explicitly requires the matched value.

---

## Step 4 — VALIDATE THE PUBLICATION TREE

Run the scrub, content-policy, link, catalog, and release checks owned by the target repository.
Record which checks ran, their results, and any skipped checks. A skipped required check leaves
the publication decision incomplete.

---

## Hard Rules

1. Do not use mass replacement as a substitute for surface classification.
2. Do not publish credentials, non-public identifiers, machine-local paths, or internal-only context.
3. Do not classify a surface as `publish_as_is` solely because it already exists in a working tree.
4. Do not run a publication workflow against an authoritative repository unless its own contract requires it.
5. Keep transformation rules and supplemental prohibited-term policies outside the publication target when they contain non-public identifiers.
