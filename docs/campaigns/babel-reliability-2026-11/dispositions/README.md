# Per-workstream disposition ledgers

One file per workstream: `W01.csv` … `W14.csv`. A stream writes only its own file, so parallel branches never conflict on the same rows. The contract, vocabulary and evidence rules live in [AUDIT_RECONCILIATION.md](../../../architecture/AUDIT_RECONCILIATION.md) and [`config/audit-reconciliation.json`](../../../../config/audit-reconciliation.json).

## Header (copy exactly)

```csv
finding_id,stream,disposition,head_sha,evidence,reviewed_head_sha,branch,commit_sha,merged_sha,artifact_kind,artifact_digest,test_evidence,closed_on
```

## Rules

- `finding_id` must match a register row owned by this stream. Do not record another stream's finding.
- `disposition` must be one of the shared vocabulary values, and the fields required for that status must be filled:
  - `reproduced_on_head` → `head_sha`, `evidence`
  - `historical` → `evidence`
  - `disproven` → `head_sha`, `evidence`
  - `coded` → `branch`, `evidence`
  - `reviewed` → `reviewed_head_sha`, `evidence`
  - `merged` → `merged_sha` (and the base SHA in `evidence`)
  - `package_qualified` → `merged_sha`, `artifact_kind`, `artifact_digest`
  - `closed` → `artifact_kind`, `artifact_digest`, `test_evidence` (plus base/merged SHAs)
- Quote fields containing commas or quotes (RFC 4180). No embedded newlines.
- Keep the evidence field factual: command or artifact, observed result, head SHA. Prose assertions are not evidence.
- A register row is updated by its owner after the ledger evidence lands. `merged` is not `closed`; `closed` requires exact artifact and test evidence.

`npm --prefix babel-cli run test:harness-acceptance` validates the header, vocabulary and required fields. The W14 ledger is a worked example.
