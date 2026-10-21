# Public content policy repair receipt (2026-10-21)

Pre-repair gate (failed; exit code 1):

```text
$ pwsh tools/check-public-content-policy.ps1 -RepoRoot .
Public content policy errors:
  PCONT010 [unscannable-tracked-file:binary-file] babel-cli/src/research/v2/fixtures/campaign/papers/1706.03762.pdf:0
  PCONT007 [unsupported-absolute-claim] babel-cli/src/research/v2/fixtures/campaign/T-L1-T2-EXECUTOR-NOTE.md:22 (clear_unsupported_claim; matched: proves)
    Rewrite with evidence-scoped language; qualified limitations such as "does not establish" are permitted.
```

Confirmed rules:

- **PCONT010** — tracked binary without a matching `binary_asset_allowlist` entry (`tracked-scan-common.psm1`: NUL byte → `binary-file`).
- **PCONT007** — unqualified certainty span `proves` on line 22 of `T-L1-T2-EXECUTOR-NOTE.md` (`clear_unsupported_claim`).

Repairs (same commit family as post-repair gate log below):

1. Pin-verified arXiv:1706.03762 offline bytes on the policy allowlist (SHA-256 matches `papers/1706.03762.manifest.json`; not a blanket PDF exemption).
2. Executor note wording scoped to injected-transport tests; live retrieval remains B-owned and unverified by A.

Post-repair verification is recorded at the end of this file after the gate is re-run.
