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
remediation mapping and re-run. The audit itself waits (bounded) for peer
required checks to conclude before evaluating, so marker comments are needed
only for genuine review events — not to re-trigger CI timing.

## Path-scoped CI

The `changes` job in `.github/workflows/typecheck.yml` classifies PR diffs.
Heavy runtime jobs (architecture-regressions, installer-lifecycle,
platform-core, harness-runtime, chat-truth, remote-ui-browser, docker-smoke)
conclude `skipped` on diffs confined to docs/markdown/CHANGELOG/LICENSE/
.gitignore and release-prep version bumps; aggregators treat failures as
blocking and skips as pass-through. Never widen the skip set without review.

## Pre-push hook

Install with `pwsh tools/install-hooks.ps1` (or
`git config core.hooksPath .githooks`). The pre-push hook runs the
AGENTS.md-required content-policy check, regenerates and verifies the policy
integrity manifest when host-protected files changed (failing if the manifest
needs committing), and runs gitleaks when available locally. CI remains the
authoritative gate; hooks are convenience.
