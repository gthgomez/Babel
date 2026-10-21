# Public content policy repair receipt (2026-10-21)

## Pre-repair (commit `31f5863c` candidate — not accepted)

Command:

```text
pwsh tools/check-public-content-policy.ps1 -RepoRoot .
```

Observed failure (exit code 1) before `31f5863c` allowlist workaround:

```text
Public content policy errors:
  PCONT010 [unscannable-tracked-file:binary-file] babel-cli/src/research/v2/fixtures/campaign/papers/1706.03762.pdf:0
  PCONT007 [unsupported-absolute-claim] babel-cli/src/research/v2/fixtures/campaign/T-L1-T2-EXECUTOR-NOTE.md:22 (clear_unsupported_claim; matched: <certainty-span>)
```

`31f5863c` added three path-specific `binary_asset_allowlist` entries for the tracked arXiv full paper. That approach is **reverted**: arXiv non-exclusive distribution is not general downstream CC permission for repository redistribution.

## Forward repair (this branch)

- **Untrack** `babel-cli/src/research/v2/fixtures/campaign/papers/1706.03762.pdf` (bytes remain in local/external cache; no history rewrite).
- **Remove** the three `1706.03762.pdf` allowlist entries from `tools/security/public-content-policy.json` (root + `canonical_independence`) and `tools/security/policy.json`.
- **Retain** `papers/1706.03762.manifest.json` (URL, SHA-256, byte length, page count) and repository-owned `mutable-locator-synthetic.pdf` for default deterministic tests.
- **Opt-in** real-paper parser verification: `BABEL_RESEARCH_V2_VERIFY_ARXIV_PAPER_CACHE=1` + `arxivPaperExternalCache.ts` (honest `missing` / `digest_mismatch` status).

## Post-repair gate (captured)

Command:

```text
pwsh tools/check-public-content-policy.ps1 -RepoRoot .
```

Output:

```text
Public content policy passed.
```

Exit code: **0**
