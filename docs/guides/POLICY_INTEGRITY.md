# Policy integrity manifest

This is a bounded text-drift detector, not an authorization mechanism or complete trust-surface certification. Runtime enforcement and the previously trusted base-rooted merge controller retain authority.

Schema 2 requires SHA-256, purpose `drift_detection_not_authorization`, and normalization `utf8_crlf_to_lf`. Each covered file must decode as valid UTF-8. Hashing converts CRLF to LF and preserves BOM, lone CR, whitespace and final-newline differences. This accommodates the repository's PowerShell CRLF checkout rule without masking substantive changes. The bundle identifier hashes sorted `path:hash` lines joined by LF, with no terminal LF. Generation sorts file registrations and emits deterministic JSON ending with LF.

## Current coverage

The registration list in `tools/policy-integrity-manifest.mjs` covers exactly these 13 files:

- `AGENTS.md`
- `docs/AUTONOMY_POLICY.md`
- `docs/AUTONOMY_POLICY_CHANGELOG.md`
- `docs/guides/AGENT_GIT_OPERATIONS.md`
- `scripts/agent-pr-gate.ps1`
- `scripts/agent-pr-gate-common.psm1`
- `scripts/agent-review-evidence.ps1`
- `scripts/trusted-merge-gate.ps1`
- `babel-cli/src/authority/lease.ts`
- `babel-cli/src/config/autonomyPolicy.ts`
- `babel-cli/src/agent/autonomyEnforcement.ts`
- `.agents/rules/10-independent-review-policy.md`
- `tools/policy-integrity-manifest.mjs`

The manifest itself is excluded to avoid recursive self-hashing. Hashing the verifier requires no recursion: finalize its source first, then generate the manifest.

The registration list preserves the existing 11 registrations and adds the independent-review rule and verifier. It does **not** yet register PR271's promoted configuration, merge executor, other protected runtime/controller modules, or workflows. Before a combined candidate can merge, reconcile this bounded list with the actual promoted `config/review-risk-policy.json` trust surface, independently review the intended content, regenerate the manifest, and verify the combined candidate. Do not interpret a successful result from this bounded list as complete host-protected coverage.

## Validation and generation

Run `node --test tools/tests/policy-integrity-manifest.test.mjs` for isolated CLI probes. Tests generate disposable fixtures; they do not regenerate the repository manifest. They cover malformed metadata and shapes, hash syntax, bundle identity, registration completeness, unreadable files, covered mutations, verifier mutation, invalid UTF-8, deterministic generation and LF/CRLF equivalence. LF/CRLF fixture tests are not a substitute for an actual Windows clean-checkout verification.

After independent source review and final coverage reconciliation, run `node tools/policy-integrity-manifest.mjs generate`, review the resulting manifest diff, then run `node tools/policy-integrity-manifest.mjs verify`. Generation must never be used to hide an unexplained verification failure. Input-validation failures leave the previous manifest untouched. Generation writes directly; interrupted or failed writes require restoration of the reviewed manifest before verification. Verification and generation failures emit structured JSON with status `FAIL` and a `problems` array.

Schema 1 manifests require reviewed regeneration for schema 2. The schema 2 manifest was generated after an independent working source review. That review is not authoritative certification; regeneration is required after the promoted-base coverage reconciliation. PR policy verification must become blocking after migration, and the final workflow must verify a clean Windows checkout as well as Linux.
