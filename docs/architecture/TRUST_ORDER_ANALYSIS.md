# Trust-root ordering analysis

Status: reviewed 2026-08-29 for reconstructed consolidation PR #126.

## Finding

PR #126 is rebuilt on a base that already contains the merged trust-root
bootstrap from PR #121. Its historical commit order is not used as a trust
boundary; the immutable base tree is.

## Evidence

The immutable PR #126 base contains
`.github/workflows/trusted-control-plane.yml`,
`scripts/trusted-merge-gate.ps1`, `scripts/verify-independent-review.mjs`, and
both public key registries. The trusted workflow checks out
`${{ github.event.pull_request.base.sha }}` and loads its gate components from
that base. It materializes the candidate head in a separate worktree as data,
then passes the exact base and head SHAs to the base-rooted gate. Candidate
changes to these paths cannot replace the verifier or workflow executed with
privileged context.

The gate requires the PR base to equal freshly fetched `origin/main`, binds
review receipts to the exact PR number, base, head, and review identity, and
resolves required checks against the exact candidate head. After the bootstrap
merge, the active `protect-main` ruleset must also require the exact
`trusted-control-plane` status check while preserving the existing required
checks. The merge authority switch is explicit and is not inferred from PR
text, CI, or a review receipt.

## Conclusion

**TRUST ROOT ESTABLISHED BEFORE CONSOLIDATION.** PR #126 cannot use candidate
content to establish or replace its trust root because the security-sensitive
workflow, verifier, public key registries, base freshness, exact-head binding,
and merge policy are evaluated from the immutable PR #126 base. The semantic
dependency order is `#121 -> #120 -> consolidation`. Final merge requires the
ruleset mutation and an exact-head successful `trusted-control-plane` check.

This proof does not claim that the historical commits are individually trusted
before the immutable-base gate is run.
