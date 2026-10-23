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

**Quick links:** Git helpers and preflight → [AGENT_GIT_OPERATIONS.md](./AGENT_GIT_OPERATIONS.md). Maintainer supplemental scrub uses `tools/check-public-scrub.ps1 -RequireSupplementalPolicy` (content/schema); optional path-only preflight → `-CheckSupplementalScrubPolicyPath`.

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
4. Record both SHAs when a branch advanced through more than one remote tip (see pilot record below).

## Slice A pilot record (measured, not projected)

| Item | Observed |
| --- | --- |
| Early catches | Stale `TRUST_ROOT_RECOVERY` ACTIVE; missing handoff link; maintainer scrub blocked after Git-only preflight looked fine |
| Misses | Initial `-DeliveryStage` scope (reverted per review); unreadable-policy test not run on Windows hosts |
| Remote branch tips (PR #422 campaign) | `cc2ffc9bbf31b7ebd46c8b35d0939b3aae4ffdd9` then `958758f99e3ec682f7bf2e60bc3890e479fb91ae` — **two remote heads**, not one publication |
| Manual push in agent log | Rejected non-FF; then `--force-with-lease=refs/heads/cursor/workflow-batch-slice-a-6a77:cc2ffc9bbf31b7ebd46c8b35d0939b3aae4ffdd9` updated tip to `958758f9`. Prior remote `cc2ffc9b` had no successful manual push in the same transcript (host auto-sync on commit is plausible; not assumed as fact beyond remote ref evidence). |
| Regression test limits | Unreadable policy file uses `chmod 000` on Linux/macOS only; Windows and root-owned files may differ — report platform honestly |

No time or cost savings claimed.
