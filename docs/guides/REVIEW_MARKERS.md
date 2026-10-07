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
`Wait-AgentRequiredChecksReady` step polls required peer checks for the target
SHA for up to 180 attempts at 10 seconds each (30 minutes) before evaluating
authoritative results. Marker comments provide review evidence; they do not
re-trigger CI timing.

## Required CI scope

The current `.github/workflows/typecheck.yml` does not have a `changes` job or
path-based classifier for skipping required jobs. Documentation-only and
release-preparation changes therefore follow the workflow's configured job
matrix; do not assume that runtime jobs will be skipped. Keep this description
aligned with the workflow when its job-selection rules change.

## Pre-push hook

Hooks are optional and do not run unless installed. Install them with
`pwsh tools/install-hooks.ps1` (or configure the equivalent repository-local
setting with `git config core.hooksPath .githooks`). If PowerShell is absent,
the hook scripts skip successfully. The pre-push hook runs the
AGENTS.md-required content-policy check, regenerates and verifies the policy
integrity manifest when host-protected files changed (failing if the manifest
needs committing), and runs gitleaks when available locally. CI remains the
authoritative gate.
