# Trusted review-root bootstrap

This narrowly scoped transition establishes the first immutable independent
review trust root for Babel. It contains only the public Ed25519 registry and
the dependency-free verifier used by the merge gate. The registry is read from
the pull request base; candidate code cannot replace either file during review.

Because the pre-bootstrap `main` commit has no reviewer registry or verifier,
this transition cannot certify itself with the new mechanism. The one-time
exception is limited to this exact bootstrap change, the active GitHub
`protect-main` ruleset, its required checks, and the current task's explicit
authority. It is not a standing bypass and must not be reused for PR #120 or
any later change.

The verifier requires a durable consumed challenge ledger, exact receipt
bindings, an authorized base key, and a valid Ed25519 signature. The private key
corresponding to the provisioned public key is held outside the repository by
the trusted review-lane operator.
