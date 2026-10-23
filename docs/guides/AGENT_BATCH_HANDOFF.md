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
