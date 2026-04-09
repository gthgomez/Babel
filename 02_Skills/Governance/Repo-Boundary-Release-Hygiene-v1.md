<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Repo Boundary Release Hygiene (v1.2)
**Category:** Governance
**Status:** Active
**Activation:** Load when a workspace contains multiple nested repos, temp/export folders, or ambiguous git roots and the task involves committing, batching, releasing, or pushing changes.

---

## Purpose

Prevent the classic multi-repo failure:

- committing from the wrong root
- sweeping unrelated files into a release
- staging temp/export artifacts because they happen to be nearby
- pushing the right change to the wrong remote
- mistaking path-only churn or local helper files for shippable release work

Use this before any release batching work in a workspace that is not a single clean repo.

If the task includes remote DB applies, live permission fixes, or environment-state repair, treat
those as release artifacts too. A repo can be clean while the live system is still drifting.

---

## Step 1 — IDENTIFY THE REAL REPO BOUNDARIES

For every target surface:

1. resolve the repo root with `git rev-parse --show-toplevel`
2. capture `git remote -v`
3. capture `git status --short --branch`
4. note whether the workspace root is itself a real release target or just a container
5. record the repo role
   - `private_source`
   - `public_derived`
   - `single_repo`

Do not assume the chat workspace root is the deployable repo.
Do not assume the local folder name matches the GitHub repo role.

---

## Step 2 — CLASSIFY PATHS BEFORE STAGING

Split changed paths into:

1. `ship`
   - intended product, docs, test, tooling, or skill changes
2. `investigate`
   - unclear untracked directories, generated bundles, copied exports, odd temp names
3. `exclude`
   - scratch files, local notes, temp folders, copied public-export output, chat extracts, debug dumps
4. `local_helper`
   - launcher scripts, machine-specific wrappers, local env helpers, one-off convenience files

Examples of high-risk investigate/exclude paths:

- `.tmp/`
- `-DestinationRoot/`
- copied export trees
- local chat extracts
- accidental repo mirrors
- `babel.ps1`
- `babel-local.ps1`
- machine-specific launchers or shortcuts

Do not stage anything from `investigate` until it is explained.
Do not stage `local_helper` by default unless the task explicitly proves it is a real repo asset.

If many files appear related, sample representative diffs before staging:

1. one control-plane/doc file
2. one code/tooling file
3. one generated/report file

Do not infer “same story” from filenames alone.

---

## Step 3 — BUILD A RELEASE MAP

Before the first `git add`, write a small release map:

1. repo name
2. repo role
3. branch
4. target remote and remote role
5. batch names
6. exact path lists per batch
7. excluded paths
8. any remote state changes that must be represented by migrations, config updates, or runbooks

If a file does not have a batch, it should not be staged.
If the repo role and target remote role do not make sense together, stop before staging.

---

## Step 4 — STAGE WITH EXPLICIT PATHS ONLY

Use explicit pathspec staging.

Preferred pattern:

```powershell
git add -- path/to/file1 path/to/file2 path/to/dir
```

Avoid:

```powershell
git add .
git add -A
```

If the staged set is wrong:

```powershell
git restore --staged -- path/to/file
```

Unstage surgically. Do not panic-stage and “fix later.”

---

## Step 5 — VERIFY EVERY BATCH BEFORE COMMIT

For each batch, inspect:

1. `git diff --cached --name-only`
2. `git diff --cached --stat`
3. spot-check `git diff --cached -- <path>` on any risky file

Then ask:

- does every staged file belong to the same story?
- is any old unrelated work mixed in?
- is any generated/scratch file included?
- is this only line-ending or absolute-path churn with no user-facing value?
- does the commit message describe all staged paths honestly?

If not, restage.

---

## Step 6 — PUSH WITH REMOTE CONFIRMATION

Before pushing:

1. confirm current branch
2. confirm target remote URL
3. confirm target remote role
4. confirm the push is appropriate for that role
   - private-source working changes -> private repo
   - public-derived release artifacts -> public repo
3. confirm local tests/validation for that batch
4. confirm no intended changes remain unstaged for the same story

After pushing:

1. check `git status --short --branch`
2. confirm branch is aligned with upstream
3. note any remaining local changes as intentionally deferred batches
4. note any remote-only state changes that still need to be represented in git

If commit hooks fail, classify the failure before bypassing anything:

1. `blocking_product_failure`
   - type-check, build, failing tests, schema errors, lint rules treated as blockers
2. `advisory_environment_failure`
   - external API key missing, optional reviewer unavailable, flaky advisory scanner, expired local token

Only consider `--no-verify` after reproducing the hook steps manually and proving the remaining failure is advisory/environmental rather than a product defect.

Examples of `advisory_environment_failure`:
- expired local API key for an optional reviewer
- unavailable external LLM review service
- missing local token for non-blocking metadata sync

Examples of `blocking_product_failure`:
- failing type-check or build
- failing migration replay or schema check
- broken tests on files in the release slice

---

## Hard Rules

1. Never release from a workspace root until the real repo root is proven.
2. Never use bulk staging in a dirty multi-repo workspace.
3. Never include unexplained untracked directories in a push.
4. Never mix skill/catalog updates, product code, and scratch exports in one commit unless they are one real story.
5. A clean release requires an explicit excluded-path list, not just a staged-path list.
6. In paired private/public systems, never push until repo role and remote role are both explicit.
7. Local helper scripts default to excluded, not investigated, unless there is a clear repo-wide maintenance reason to ship them.
8. Path-only normalization and generated report churn are separate stories until proven otherwise.
9. A hook failure cannot be called advisory unless equivalent product checks were run manually and passed.
10. A live remote fix that is not committed back into the repo is release debt, not completion.
