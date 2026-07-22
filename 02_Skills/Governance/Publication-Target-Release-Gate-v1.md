<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Publication Target Release Gate (v1.0)
**Category:** Governance
**Status:** Active
**Activation:** Load before publishing to a repository classified as `publication_target`.

---

## Purpose

Require evidence that the selected publication surface matches the target's repository role,
content policy, and validation contract before any remote mutation.

---

## Step 1 — REQUIRE A PUBLICATION DECISION

Before a push or pull request, identify the target as `publication_target` and classify every
touched artifact as:

- `publish_as_is`
- `transform_before_publication`
- `retain_in_authoritative_repo`

Exclude every `retain_in_authoritative_repo` item from the publication set.

---

## Step 2 — FOLLOW THE TARGET-OWNED WORKFLOW

Use the publication selection, transformation, checklist, and validation tools documented by
the target project. Do not assume another repository's commands or policy apply.

The default sequence is:

1. prepare reviewed content in the authoritative repository
2. select or transform the publication surface
3. validate the publication target
4. review exact staged paths
5. mutate the remote only after required gates pass

---

## Step 3 — REQUIRE RELEASE EVIDENCE

Record:

1. exact staged path list
2. excluded path list and classification reasons
3. scrub/content-policy results
4. catalog/link/build/release results required by the target
5. skipped checks and their effect on the decision

Missing required evidence produces an incomplete decision, not a release-ready verdict.

---

## Step 4 — MINIMIZE UNCERTAIN PUBLICATION

When ownership or classification remains unresolved, omit the artifact and report the decision
needed to include it later.

---

## Hard Rules

1. Do not treat publication-target delivery as an ordinary working-tree push.
2. Do not publish from a repository that has not been mapped to the target's declared workflow.
3. Do not mutate the remote before required classification and validation gates pass.
4. Existing presence in a local tree is not evidence of publication approval.
5. Do not classify an authoritative canonical repository as a publication target without explicit project documentation.
