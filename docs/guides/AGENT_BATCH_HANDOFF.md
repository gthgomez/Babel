<!-- License: Apache-2.0 — see LICENSE -->
<!-- status: ACTIVE -->

# Batch handoff template

[AGENTS.md](../../AGENTS.md) owns policy. Copy the table into your private task record; do not treat this page as authority.

| Field | Value |
| --- | --- |
| Task / acceptance | |
| Authority / restrictions | |
| Owner · reviewer · merge controller | |
| Branch · base SHA · head SHA | |
| Dependencies · active CI run IDs | |
| Known related failures | |

**Quick links:** Git helpers and preflight → [AGENT_GIT_OPERATIONS.md](./AGENT_GIT_OPERATIONS.md). Product proof uses `npm --prefix babel-cli run typecheck` for source and `tsconfig.scripts.json` (scripts-only drift). Maintainer supplemental scrub: validate JSON with `tools/check-public-scrub.ps1 -RequireSupplementalPolicy`; optional readable-path preflight only → `-CheckSupplementalScrubPolicyPath` (does not replace scrub validation).

**Footer when handing off:** changed/excluded paths; commands + exit results; reuse basis; blocker + stage; next owner/action.

## Symptom → early check (reference)

| Symptom | Where to look |
| --- | --- |
| Scripts-only type errors | `npm --prefix babel-cli run typecheck` (both tsconfigs) |
| Windows npm EINVAL in tests | `process.execPath` + `npm_execpath`; hosted `windows-portability` |
| Trusted boundary vs candidate triggers | Base-owned test on main; may need a main PR, not candidate-only |
| Maintainer scrub “not configured” | `BABEL_PRIVATE_SCRUB_POLICY_PATH` + `check-public-scrub.ps1 -RequireSupplementalPolicy` |
| V3/signing confusion | Optional publication; AGENTS + live gate advisory mode for custom evidence |
| Missing Node/PowerShell/Gitleaks at dispatch | Existing commands: `node --version`, `pwsh -NoProfile -Command '$PSVersionTable.PSVersion'`, `gitleaks version` (or hosted job pending) |
| Packaged worker/asset drift | `babel-cli/package.json` `files` / worker entries; consumer or package jobs when packaging changes |

## Before dispatch (existing commands only)

- Tool inventory: `node --version`, `pwsh -NoProfile -Command '$PSVersionTable.PSVersion'`, `gh auth status` — no new installer framework.
- Policy prerequisites: search authorized branches/remotes for referenced paths before asking the user; configure `BABEL_PRIVATE_SCRUB_POLICY_PATH` off-repo; validate content with `tools/check-public-scrub.ps1 -RequireSupplementalPolicy`, not preflight alone.
- Remote ownership: `git fetch origin <branch>` and compare `origin/<branch>` to local HEAD **before** amending or rewriting.

## Publication (truthful procedure)

1. Local commits are checkpoints, not proof of a single remote publication.
2. After any remote branch exists, prefer **additive** commits and a normal `git push`; do not amend or force-push without explicit owner authority.
3. `--force-with-lease` binds to an expected remote SHA; it is not merge authority and does not erase prior remote heads from history.
4. When a branch advanced through more than one remote tip, record the sequence in your private task record, not in public docs.
