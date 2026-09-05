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

## Custody outcome (2026-09-05 bootstrap-history audit)

The condition this document stated — private counterparts "must be
provisioned by the repository owner" before the trust root is certifiable —
was **never verifiably completed**:

- reviewer proof-of-possession history: `NOT_FOUND`;
- supervisor proof-of-possession history: `NOT_FOUND`;
- the reviewer key was silently re-keyed (`trusted-reviewer-ed25519-v1` →
  `trusted-reviewer-ed25519-v2`) on the day both were introduced, with no
  possession ceremony recorded;
- no custody-completion record, signing-service configuration, or signed
  ceremony artifact exists anywhere in repository history.

Both registered public keys are therefore classified
`LEGACY_UNPROVEN_AUTHORITY` (see
[TRUST_SIGNING_CUSTODY.md](./TRUST_SIGNING_CUSTODY.md)): registered public
roots whose private counterparts may exist offline, may never have been
preserved, or may never have been generated. Only an owner proof-of-possession
ceremony or the recovery lane can resolve this. Unknown stays unknown until
evidence changes it.
