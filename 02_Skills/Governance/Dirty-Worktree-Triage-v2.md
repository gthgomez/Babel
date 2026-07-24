<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Dirty Worktree Triage (v2.0)
**Category:** Governance
**Status:** Active
**Activation:** Load when a repo is already dirty before release work, when the user asks what should or should not be committed, or when many unrelated changed files must be separated into commit buckets versus no-commit local state.

## Package bridge

- **Canonical package:** `skills/dirty-worktree-triage/` (`SKILL.md`, `skill.yaml`, `contracts/`, `examples/`, `tests/`)
- **Catalog id:** `skill_dirty_worktree_triage`
- **This file:** Babel prompt routing and layer behavior only
- Do not duplicate schemas or examples here; use the package skill for I/O contracts and fixtures

---

## Purpose

Turn a confusing dirty worktree into an explicit decision table:

- `commit_now`
- `separate_commit`
- `defer_review`
- `no_commit_local_only`

This skill is for classification and release judgment, not for implementation.

If the incident involved manual remote changes, classify those too:
- `represented_in_git`
- `remote_only_drift`

---

## Step 1 — TAKE A WORKTREE SNAPSHOT

Capture:

1. `git status --short --branch`
2. `git diff --name-only`
3. `git diff --stat`
4. the explicit staged set, if anything is already staged

Do this before proposing any commit plan.

---

## Step 2 — CLUSTER BY CHANGE SHAPE

Group files by why they changed, not by extension.

Typical clusters:

1. `product_release_slice`
2. `docs_control_plane`
3. `scanner_path_normalization`
4. `generated_reports`
5. `local_helpers`
6. `unknown`
7. `advisory_hook_artifacts`

Examples:

- AGENTS / CLAUDE / GEMINI / rule files -> usually `docs_control_plane`
- scanner analyzers and report path rewrites -> usually `scanner_path_normalization`
- launcher scripts like `babel.ps1` -> usually `local_helpers`
- hook-generated review json or logs -> usually `advisory_hook_artifacts` or `generated_reports`

---

## Step 3 — SAMPLE REPRESENTATIVE DIFFS

For each cluster, inspect a small representative sample before classifying the whole cluster:

1. one file near the root
2. one file from a subdirectory
3. one file with the largest diff or highest risk

Look for:

- real semantic behavior change
- path-only rewrite
- line-ending-only churn
- regenerated artifact noise
- local-machine assumptions

Never classify a cluster from filenames alone.

---

## Step 4 — ASSIGN A RELEASE DECISION

For each cluster, choose exactly one:

1. `commit_now`
   - cohesive, validated, and part of the intended story
2. `separate_commit`
   - real repo value, but a distinct story from the current release
3. `defer_review`
   - not understood well enough yet
4. `no_commit_local_only`
   - convenience wrappers, machine-specific launchers, local environment aids

Default judgments:

- generated reports are `separate_commit` or `defer_review`, never auto-include
- absolute-path rewrites are `separate_commit` only if the workspace migration is intentional and broad
- local helper scripts are `no_commit_local_only` unless they are explicitly adopted as team tooling
- hook artifacts from failed advisory review runs are `defer_review` or `exclude`, not release cargo

---

## Step 5 — EMIT A TRIAGE MAP

Output a compact map with:

1. cluster name
2. representative paths
3. observed diff pattern
4. decision
5. why it should or should not be pushed
6. whether any live remote fix still lacks a repo artifact

The release is not ready until every dirty cluster has a stated disposition.

---

## Hard Rules

1. Never recommend `git add .` in a dirty worktree.
2. Never call a file “safe to commit” without sampling its diff.
3. Never let local helper files hitchhike on a product release.
4. Never fold regenerated reports into code releases just because they changed last.
5. If a cluster mixes path normalization and substantive edits, split it before recommending a commit.
6. Failed-hook artifacts are not evidence of a product change by themselves.
7. A manual DB or platform fix that is not backed by a migration, config change, or runbook entry is `remote_only_drift`, not done.

---

## Boundaries — Do Not Overstep
- This skill provides Babel-specific governance and release conventions. It does not replace official platform documentation or security best-practice guides.
- Version-specific guidance must be verified against current stable releases before use in production plans.

## Failure Behavior of This Skill
- **Referenced policy or process is outdated:** Flag as STALE. Recommend verification against current Babel governance documentation.
- **Guidance conflicts with another governance skill:** Activate `coherence-linter` to detect and resolve.
- **Release/security gate fails:** Halt the release. Do not proceed with a failing gate.

## Strategic Next Move
After every substantial response, end with one strategic next-move question focused on the highest-leverage validation step.

## References
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening governance patterns.
- `skill_standards_currency_audit` (`02_Skills/Governance/Standards-Currency-Audit-v2.md`) — for scheduled re-verification.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting contradictions.

---

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-20 per Phase 4 Tier 3 Migration — Block 2 (Governance & Release).
