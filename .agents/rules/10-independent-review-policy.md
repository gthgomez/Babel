<!--
status: ACTIVE
last_verified: 2026-09-05
-->
# Independent Review Routing

“Independent review required” is not itself a human or external blocker.

When independent review is required, the implementation agent must first
attempt an available isolated read-only AI reviewer, reviewer subagent, review
lane, or configured review broker. The reviewer must inspect the exact
immutable base/head candidate and must have no candidate write authority, no
merge authority, and no GitHub mutation authority.

Reviewer output is analysis evidence, not trusted approval. The builder must
not self-approve, mint a trusted receipt, or receive reviewer or supervisor
private signing credentials.

After the AI review completes, the system must separately attempt the trusted
issuer and supervisor/challenge path. Classify failures separately:

- `MISSING_REVIEWER` — no isolated reviewer is available;
- `MISSING_REVIEW_ORCHESTRATOR` — no safe invocation path exists;
- `MISSING_ISSUER` — no trusted receipt issuer is configured;
- `MISSING_SUPERVISOR` — no trusted challenge/ledger authority is configured;
- `MISSING_SIGNING_AUTHORITY` — protected signing custody is unavailable;
- `VERIFICATION_FAILURE` — the produced evidence does not validate.

The absence of a signed receipt alone must never be called a human-review
requirement. Only genuinely unavailable protected authority after the
configured autonomous certification path has been attempted is a capability
blocker.

The default loop is:

```text
NEED_REVIEW → SPAWN_AI_REVIEWER → FIX_FINDINGS → CERTIFY → CONTINUE
```

Failures are work items until a materially ambiguous objective or genuinely
unavailable required capability has been proven.

Production certification is invoked as `babel review certify --pr <number>`.
The command resolves the live PR and exact base/head itself. `--candidate` and
`--review-result` are fixture-only inputs for deterministic tests. Trusted
service custody is configured outside the builder process through
`BABEL_REVIEW_PROVENANCE_SIGNER`, `BABEL_TRUSTED_REVIEW_ISSUER`, and
`BABEL_TRUSTED_REVIEW_VERIFIER`; their command arguments are supplied through
the corresponding `*_ARGS` JSON-array variables. The builder receives signed
results, never reviewer or supervisor private keys.

`CERTIFIED` means the base-rooted trusted verifier returned PASS. A completed
AI review without authenticated provenance is `ISSUER_CONFIGURATION_REQUIRED`;
an issued receipt awaiting authoritative verification is
`READY_FOR_TRUST_VERIFICATION`.

## Review tiers for ordinary PRs

Ordinary (non-trust-root) candidates satisfy independent review through
either implemented tier:

- **CERTIFIED** — a signed `independent_review_receipt_v1` bound to a
  supervisor-signed consumed challenge, verified by the base-rooted
  verifier against `config/independent-review-keys.json`; or
- **AUTONOMOUS** — structured `autonomous_review_evidence_v1` from an
  isolated read-only AI reviewer (reviewer ≠ builder, exact base/head
  binding, `diff_numstat_digest` over `git diff --numstat base...head`),
  transported the same way as receipts. AUTONOMOUS evidence is accepted
  under current repository policy for ordinary candidates only; the
  isolation and no-write constraints above apply to it identically.

Trust-root modifications never accept the AUTONOMOUS tier. A candidate that
touches the protected trust-root paths (the `config/` key registries, the
verifier and gate scripts, or the evidence transport) requires the CERTIFIED
tier plus a supervisor-signed TrustRootUpgradeV1 authorization.

## Assurance language — what each tier establishes

- **Candidate engineering review** (any reviewer, including isolated AI
  reviewers during development) is useful assurance but is never trusted
  authorization and never substitutes for a signed receipt.
- **AUTONOMOUS review** is mechanically bound evidence accepted under
  ordinary-PR policy; its process-isolation properties are asserted by policy,
  not cryptographically proven. Never describe it as a cryptographic
  certification.
- **CERTIFIED review** is cryptographically authorized independent review
  using trusted custody.
- **TrustRootUpgradeV1** is CERTIFIED review plus supervisor authorization,
  required for protected trust-root changes.

Trust-root candidates follow the ceremony state machine in
[`docs/architecture/TRUST_CEREMONY_LIFECYCLE.md`](../../docs/architecture/TRUST_CEREMONY_LIFECYCLE.md):
coordinates come only from the machine-generated ceremony manifest
(`tools/trust-ceremony.mjs`), the candidate is frozen before signing, preflight
must pass immediately before signing, and any candidate mutation invalidates
all prior ceremony artifacts.
