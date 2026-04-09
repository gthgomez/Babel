<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Private Source Repo Discipline (v1.1)
**Category:** Governance
**Status:** Active
**Activation:** Load when a project has both a private source-of-truth repo and a derived public repo, especially when local folder names, git remotes, or GitHub repo names can be confused.

---

## Purpose

Prevent the highest-cost paired-repo mistake:

- pushing private-source work to the public repo
- assuming the local folder name matches the GitHub repo role
- treating a derived public repo as the master system
- accidentally shipping local helper surfaces that only make sense in one private machine layout

This skill establishes which repo is authoritative, which repo is derived, and which remote is allowed for normal day-to-day pushes.

---

## Step 1 — BUILD A REPO ROLE MAP

Before any commit or push, write a `repo_role_map` with:

1. local folder path
2. repo role
   - `private_source`
   - `public_derived`
3. GitHub repo name
4. default push remote
5. allowed content class
   - `all_working_changes`
   - `sanitized_export_only`

If the task touches Babel specifically, start by reading the repo-role and paired-repo workflow docs for the current private/public repo set.

If those files and the git remotes disagree, stop and treat it as a repo-configuration bug.

---

## Step 2 — ENFORCE DEFAULT PUSH RULES

For a `private_source` repo:

- push ordinary feature, tooling, skill, overlay, and local-learning changes there
- set `origin` to the private repo whenever possible
- keep the public repo on a separate remote such as `public`
- still exclude machine-local launchers and convenience wrappers unless they are adopted as repo tooling

For a `public_derived` repo:

- never push raw working changes from the private system
- push only sanitized export artifacts and public-only hardening

The rule is simple:

- private work goes to the private source repo
- public releases go through the derived public repo

---

## Step 3 — CHECK REMOTE ROLE, NOT JUST REMOTE URL

Before pushing, verify:

1. current repo role
2. target remote role
3. whether this push is normal private development or a public release

Do not stop at “the URL looks familiar.”

The push is wrong if:

- the local repo is `private_source` but the target remote is public
- the local repo is `public_derived` but the content includes unsanitized private material
- the folder name suggests one role while `origin` points to the other

---

## Step 4 — SEPARATE NORMAL PUSHES FROM PUBLIC RELEASES

If the target is `private_source`:

- commit and push normally after repo-boundary hygiene

If the target is `public_derived`:

- switch from normal release mode into public-release mode
- load the public export/release gate before any push

Do not improvise the public release path from memory.

When helper scripts or launchers are present, classify them explicitly:

- `repo_tooling`
- `private_machine_helper`

Only `repo_tooling` belongs in normal pushes.

---

## Hard Rules

1. Never assume the local folder name tells you the GitHub repo role.
2. Never let a private-source repo keep `origin` pointed at the public repo once that mismatch is discovered.
3. Never push private-source working changes directly to a public-derived repo.
4. If repo-role docs and git remotes disagree, fix the mapping before continuing.
5. A paired private/public system must always have an explicit repo-role map before release work.
6. A helper file is not automatically repo tooling just because it was useful during one session.
