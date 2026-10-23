# Review-evidence markers and local gates

How independent review evidence reaches the trusted-control-plane audit, and
the local checks that keep pushes green.

## Markers

The `trusted-control-plane` workflow re-runs its merge audit when the
repository owner comments on a PR starting with one of:

- `<!-- babel-controller-independent-review-v3 -->` — human independent review
- `<!-- babel-controller-ai-reviews-v2 -->` — independent AI review

Post via the helper, which writes the marker, reviewer identity, exact
reviewed head, verdict, summary, and findings:

```powershell
pwsh tools/post-ai-review.ps1 -PR <n> -HeadSha <full-40-hex> `
  -Verdict APPROVE|CHANGES_REQUESTED -Reviewer "<identity>" `
  -Summary "<paragraph>" [-FindingsFile <markdown-file>]
```

Evidence binds to the head it names; after remediation commits, post the
remediation mapping and re-run. The `trusted-control-plane` workflow calls
`scripts/trusted-merge-gate.ps1`, which materializes the trusted-base gate
components and invokes `scripts/agent-pr-gate.ps1`. Its
default invocation takes one current snapshot and reports pending checks.
`-CheckWaitSeconds <0..1800>` explicitly requests a bounded wait with backoff;
cheap review and identity blockers are checked first. The `workflow_run`
listener resumes the trusted audit when product CI completes. Marker comments
provide review evidence and do not restart product checks.

## Required CI scope

`typecheck.yml` uses `tools/ci-merge-lane.mjs`: docs and skills can take the fast
lane; runtime and tooling changes require the full matrix. The trusted base
classifier and its policy are materialized together and unioned with the head
decision. Missing trusted inputs require full qualification.

Readiness and draft transitions rerun the trusted metadata audit. Label changes
retain ordinary `pull_request` product qualification because `full-ci` raises
the required matrix and installer coverage. A newer eligible run still
invalidates an older success for the same head until it completes.

## Local execution vs planning preflight

`scripts/agent-preflight.ps1` emits readiness JSON (auth, branch, worktree). It
does **not** verify policy-manifest drift, committed `AGENTS.md` interactive
budget, or push-candidate scans. Those are execution checks.

Before committing policy paths, run (or rely on an installed pre-commit hook):

```bash
node tools/validate-push-candidates.mjs --staged-manifest
```

Before push, run the read-only helper (hook ownership label + optional staged
cheap checks + ls-remote frontier for the **current branch**):

```bash
node tools/verify-changed-publication-surface.mjs --candidate "$(git rev-parse HEAD)"
```

Full push validation (manifest per candidate, gitleaks, public-content) remains the
real execution stage:

```bash
node tools/validate-push-candidates.mjs origin < push-records.txt
```

**Hook activation:** Babel hooks live in `.githooks/` (pre-commit runs
`--staged-manifest` then leak scans). They run only when
`core.hooksPath` points at `.githooks` (`pwsh tools/install-hooks.ps1`).
Do **not** replace or chain-swap a host-managed hook dispatcher; code changes
do not activate hooks. When `core.hooksPath` is host-managed, run the explicit
CLI validators above. The helper reports only `repo:.githooks`, `host-managed`,
or `unset` — never host-specific absolute paths in public output.

## Pre-push hook

Install with `pwsh tools/install-hooks.ps1` (or
`git config core.hooksPath .githooks`). The pre-push hook requires both Node.js
and PowerShell and fails closed if either is unavailable. It validates the
exact committed candidates being pushed against the content policy and
policy-integrity manifest, then requires gitleaks. Every candidate's cheap path
and manifest checks run before expensive scanning. The validator uses the actual
pushed ref records and an authenticated destination advertisement; corrections
can supersede older CI. Merge still requires the current candidate's results.

Committed blobs are materialized without checkout filters or candidate code;
symlinks are inspected as target text. A push-owned in-memory cache reuses
file-local content decisions bound to bytes, path, validator, policy and UTC
date. Links, titles and other tree-wide rules are checked for every snapshot.
No persistent PASS file is trusted. Stage timing, heartbeats, exit status and
bounded rule/path-digest diagnostics make progress observable without exposing
rejected source. The hook never regenerates tracked files.
