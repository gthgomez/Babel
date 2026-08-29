# Trusted review-root bootstrap

This narrowly scoped transition establishes the first immutable independent
review and supervisor trust roots for Babel. It contains only the public
Ed25519 registries and the dependency-free verifier used by the merge gate. The
registries are read from the pull request base; candidate code cannot replace
either file during review.

Because the pre-bootstrap `main` commit has no reviewer registry or verifier,
this transition cannot certify itself with the new mechanism. The one-time
exception is limited to this exact bootstrap change, the active GitHub
`protect-main` ruleset, its required checks, and the current task's explicit
authority. It is not a standing bypass and must not be reused for PR #120 or
any later change.

The verifier requires a durable consumed challenge ledger, an authenticated
supervisor-signed challenge state, exact receipt bindings, an authorized base
reviewer key, and a valid Ed25519 signature. The supervisor signature and the
reviewer receipt signature are intentionally different authority lanes.

The public keys in this transition are only trust-root declarations. Their
private counterparts must be provisioned by the repository owner in an
isolated review/supervisor environment; builder execution must never receive
either private key. This PR is not merge-certifiable until that custody is
independently established.
