# Policy integrity manifest

This is a bounded text-drift detector, not an authorization mechanism or complete trust-surface certification. Runtime enforcement and the previously trusted base-rooted merge controller retain authority.

Schema 2 requires SHA-256, purpose `drift_detection_not_authorization`, and normalization `utf8_crlf_to_lf`. Each covered file must decode as valid UTF-8. Hashing converts CRLF to LF and preserves BOM, lone CR, whitespace and final-newline differences. This accommodates the repository's PowerShell CRLF checkout rule without masking substantive changes. The bundle identifier hashes sorted `path:hash` lines joined by LF, with no terminal LF. Generation sorts file registrations and emits deterministic JSON ending with LF.

## Current coverage

The explicit registration list in `tools/policy-integrity-manifest.mjs` covers 126 files. It retains the original policy files and includes every currently tracked file matching the promoted `config/review-risk-policy.json` host-protected prefixes, plus the reviewer documentation and verifier. Future protected files require reviewed registration updates. Verification detects drift; it grants no review or merge authority.

The manifest is excluded to avoid recursive self-hashing. Finalize the verifier source before generating the manifest.

## Validation and generation

Run `node --test tools/tests/policy-integrity-manifest.test.mjs` for isolated CLI probes. Tests generate disposable fixtures; they do not regenerate the repository manifest. They cover malformed metadata and shapes, hash syntax, bundle identity, registration completeness, unreadable files, covered mutations, verifier mutation, invalid UTF-8, deterministic generation and LF/CRLF equivalence. LF/CRLF fixture tests are not a substitute for an actual Windows clean-checkout verification.

After independent source review and final coverage reconciliation, run `node tools/policy-integrity-manifest.mjs generate`, review the resulting manifest diff, then run `node tools/policy-integrity-manifest.mjs verify`. Generation must never be used to hide an unexplained verification failure. Input-validation failures leave the previous manifest untouched. Generation writes directly; interrupted or failed writes require restoration of the reviewed manifest before verification. Verification and generation failures emit structured JSON with status `FAIL` and a `problems` array.

Schema 1 manifests require reviewed regeneration for schema 2. The combined schema 2 manifest is regenerated after coverage reconciliation. Ordinary working review is not authoritative certification. CI verifies clean Linux and Windows checkouts; the policy-integrity job fails on drift instead of using continue-on-error. The GitHub ruleset retains its five standard required contexts; policy-integrity is an additional CI diagnostic.
