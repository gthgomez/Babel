<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: GitHub Release Batching (v1.1)
**Category:** Governance
**Status:** Active
**Activation:** Load when local changes must be released to GitHub in multiple commits or pushes, especially when the user explicitly asks for batching, release hygiene, or safe deployment sequencing.

---

## Purpose

Turn a dirty repo into a clean GitHub release sequence without mixing unrelated work.

This skill is about release slicing, not feature implementation.

Use it after repo boundaries are known and before commits are created.
If the worktree is already dirty, load dirty-worktree triage first.

---

## Step 1 — CHOOSE BATCHES BY STORY

Batch by cohesive user-facing stories, not by file type.

Good batch shapes:

- product schema + API + UI for one feature
- docs + packaging + tests for one release surface
- Babel skill + catalog + validation updates for one capability

Bad batch shapes:

- “all markdown files”
- “all tests”
- “all untracked files”

Each batch should answer: what changed, why it belongs together, and how it was validated.

---

## Step 2 — ORDER BATCHES SAFELY

Preferred ordering:

1. capability/governance scaffolding
2. implementation changes
3. docs/examples/packaging alignment
4. cleanup-only commits
5. path-normalization or generated-report cleanup

If a later batch depends on an earlier one, commit the dependency first.

---

## Step 3 — REQUIRE A BATCH CHECKLIST

Before committing a batch, confirm:

1. staged files are intentional
2. the batch has a single sentence summary
3. verification was run for that batch or is explicitly impossible
4. commit message matches the staged story
5. any hook failure is classified as blocking vs advisory

Suggested commit format:

```text
<scope>: <what changed>
```

Examples:

- `babel: add GitHub release hygiene skills`
- `example_saas_backend: add explicit GPC decision evidence states`
- `scanner: lock public report schema and edge-case coverage`

---

## Step 4 — USE PRE-PUSH REVIEW

Before each push:

1. inspect recent commits with `git log --oneline --decorate -n <count>`
2. confirm no batch should be squashed or reordered first
3. verify the working tree still contains only intentional deferred changes
4. name the deferred buckets explicitly rather than saying “other changes remain”

If hooks fail, do not jump directly to `--no-verify`.
First rerun the relevant checks manually and record whether the remaining failure is:

- product-blocking
- advisory but environment-dependent
- tooling drift in the hook itself

If multiple repos are involved, repeat this per repo. Do not treat the workspace as one release unit.

---

## Step 5 — CLOSE THE LOOP

After pushing:

1. confirm upstream alignment
2. list which local changes remain
3. state whether remaining changes are:
   - intentionally deferred
   - excluded scratch/temp material
   - still unreviewed

The release is not “done” until the remaining local state is explained.

---

## Hard Rules

1. Never batch by convenience; batch by narrative cohesion.
2. Never commit before checking the staged diff.
3. Never push a repo while assuming another nested repo is included.
4. Never call a release complete if unexplained local changes remain.
5. When in doubt, make more smaller commits, not one larger ambiguous one.
6. `--no-verify` is a last resort for advisory/environmental hook failures after manual verification, not a shortcut around unknown failures.
