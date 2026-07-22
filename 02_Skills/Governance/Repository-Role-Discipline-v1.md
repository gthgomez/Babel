<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Repository Role Discipline (v1.0)
**Category:** Governance
**Status:** Active
**Activation:** Load when a workspace contains multiple repositories or publication targets and folder names, remotes, or repository roles could be confused.

---

## Purpose

Establish which repository is authoritative, which repository is a publication target, and
which remote is valid for the requested operation. Repository roles come from current project
documentation and Git configuration, not from legacy folder names or assumptions.

---

## Step 1 — BUILD A REPOSITORY ROLE MAP

Record:

1. resolved repository root
2. repository role:
   - `authoritative`
   - `publication_target`
   - `standalone`
3. repository name and remote URL
4. default push remote
5. allowed content policy:
   - `normal_changes`
   - `publication_ready_only`

If project documentation and remotes disagree, stop and report a repository-configuration issue.

---

## Step 2 — ENFORCE ROLE-APPROPRIATE OPERATIONS

For an `authoritative` or `standalone` repository, ordinary reviewed changes may follow the
repository's normal contribution workflow.

For a `publication_target`, accept only content that passed the declared publication selection,
sanitization, and validation workflow. Do not push an unreviewed working tree from another repository.

---

## Step 3 — VERIFY THE TARGET BEFORE GIT OPERATIONS

Before committing, pushing, tagging, or opening a pull request, verify:

1. current repository role
2. target remote role
3. requested operation
4. allowed content policy
5. exact staged paths

A familiar remote name or folder name is not sufficient evidence.

---

## Step 4 — CLASSIFY HELPERS

Classify launchers, wrappers, and environment helpers as either:

- `repository_tooling`
- `machine_local_helper`

Only reviewed `repository_tooling` belongs in normal publication or release changes.

---

## Hard Rules

1. Do not infer repository role from a folder name.
2. Do not push content to a remote whose role conflicts with the staged content policy.
3. Do not treat a publication target as the authoritative repository without explicit project documentation.
4. Resolve documentation/remote disagreement before continuing.
5. Record a repository-role map before release work in a multi-repository workspace.
