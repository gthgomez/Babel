# PR #126 Bootstrap Reconciliation

Status: reconstructed 2026-08-29 on the local PR #121 bootstrap head.

PR #121 is the one-time trust-root bootstrap. Its immutable recovery ref is
`recovery/20260829/pr121-pre-rebase-19bc70e`; the reconstructed local base is
`e9bf3b5a58174617c8626e8043b7baf8990448cb`. PR #126 is therefore reviewed
against a base that already contains the trust root.

| Surface | Disposition | Evidence |
| --- | --- | --- |
| `.github/workflows/trusted-control-plane.yml` | KEEP_AS_HARDENING | The base version is authoritative and includes `persist-credentials: false`; the duplicate PR #126 copy is not replayed over it. |
| `config/independent-review-keys.json` | DROP_AS_DUPLICATE | Identical trust-root registry is already in the reconstructed base. |
| `config/trusted-supervisor-keys.json` | DROP_AS_DUPLICATE | Identical trust-root registry is already in the reconstructed base. |
| `docs/architecture/TRUST_ROOT_BOOTSTRAP.md` | DROP_AS_DUPLICATE | Bootstrap contract is already in the reconstructed base. |
| `scripts/verify-independent-review.mjs` | DROP_AS_DUPLICATE | Base-rooted verifier is already in the reconstructed base. |
| `scripts/agent-pr-gate.ps1` | KEEP_AS_HARDENING | PR #126 adds challenge-ledger verification, complete review-thread pagination, and exact task/run/contract bindings; its portable Git resolution is retained. |
| `scripts/trusted-merge-gate.ps1` | KEEP_AS_HARDENING | PR #126 forwards the additional exact-review binding fields to the hardened gate; it does not establish a second trust root. |
| `tools/tests/test-trust-root-boundaries.ps1` | KEEP_AS_HARDENING | The base-rooting assertions are retained and extended to prevent unsupported launcher parameters, credential persistence, and platform-specific Git defaults. |

No security-sensitive conflict was resolved silently. The final PR body must
state that its base contains the merged trust root and that
`trusted-control-plane` is required by the live `protect-main` ruleset before
merge.
