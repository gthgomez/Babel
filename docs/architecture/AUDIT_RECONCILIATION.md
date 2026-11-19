# Audit reconciliation contract

<!--
status: ACTIVE
last_verified: 2026-11-18
-->

> **Role**: how the six original audits, the 100-finding register and per-workstream dispositions fit together without one PR silently becoming canonical truth. **Not contributor policy** (root [AGENTS.md](../../AGENTS.md)), **not a release qualification**, and **not a competing agent rulebook**. If this page and `AGENTS.md` disagree, `AGENTS.md` wins.

## Authority order

1. Root [`AGENTS.md`](../../AGENTS.md) — sole contributor operating-policy owner.
2. Issue [#521](https://github.com/gthgomez/Babel/issues/521) and the canonical register `docs/campaigns/babel-reliability-2026-11/FINDINGS_INDEX.csv` — finding identity, owner and status.
3. Program ROADMAP (PR #536, branch `docs/six-audit-parallel-wave-20261118`) — wave sequencing and dependency graph.
4. This page and [`config/audit-reconciliation.json`](../../config/audit-reconciliation.json) — the evidence vocabulary and the per-stream landing files.
5. Workstream issues W01–W14 — scope and acceptance for one stream.

At `90583d97` the register exists only as a proposal in PR #536 (branch `docs/six-audit-parallel-wave-20261118`). Until that PR merges, no repository page may claim a canonical reconciled register exists. Audit text pinned to `198193b1` is historical evidence, never a current-head assertion.

## Audit archive identity

- **Reports:** six independent audits, referenced as A1–A6 in the register's `Original audit refs` column. A1–A5 were user-supplied on 2026-11-18; A6 is the sixth report in private PR #164. The public register deduplicates them into 100 stable finding IDs.
- **Source scope:** `main` at `198193b1` for the first five; the sixth report has private scope. Neither is a statement about current `main`.
- **Authorship and raw archives:** recorded in the private audit evidence record, not republished here. This repository carries only non-exploitative summaries, command-level evidence and links.
- **Duplicates:** a behavior reported by several audits keeps one ID and lists every source reference; it is not counted twice. The register validator enforces unique IDs and exact per-stream counts.
- **Canonicality:** no single report or PR description is authoritative. A report becomes actionable only through a register row, an owner and reproduced-or-disproven evidence on a named head.

## Evidence vocabulary

`config/audit-reconciliation.json` is authoritative. A disposition moves forward only through these states; skipped states stay explicitly unknown.

| Status | Meaning | Required evidence |
| --- | --- | --- |
| `audited` | Recorded from an audit only; not rechecked on current head | — |
| `reproduced_on_head` | Independently observed on a named current head | `head_sha`, `evidence` |
| `historical` | True of an older snapshot or private record; not a current defect | `evidence` |
| `disproven` | Explicitly not observed on a named current head | `head_sha`, `evidence` |
| `coded` | A repair/test/measurement exists on a branch | `branch`, `evidence` |
| `reviewed` | Independent review of the exact head completed | `reviewed_head_sha`, `evidence` |
| `merged` | Reviewed head is in the target branch | `merged_sha` (base SHA belongs in `evidence`) |
| `package_qualified` | Exact built artifact kind and digest tested | `merged_sha`, `artifact_kind`, `artifact_digest` |
| `closed` | Qualified artifact plus qualifying test evidence | `merged_sha`, `artifact_kind`, `artifact_digest`, `test_evidence` |

**A green PR, merged commit or CI job is not `package_qualified`, and `merged` never implies `closed`.** Missing cost is not zero; missing proof is not success.

## Per-stream dispositions (no shared-file conflicts)

Each workstream records its own rows in its own file:

```text
docs/campaigns/babel-reliability-2026-11/dispositions/W01.csv … W14.csv
```

- One file per stream. W01 writes only `W01.csv`; W14 writes only `W14.csv`. Parallel branches therefore never edit the same ledger row.
- The header is fixed and shared:

  `finding_id,stream,disposition,head_sha,evidence,reviewed_head_sha,branch,commit_sha,merged_sha,artifact_kind,artifact_digest,test_evidence,closed_on`
- A row may only carry a status whose required fields are filled. Leave inapplicable fields empty rather than guessing.
- The register row itself is updated only by its owning stream after the evidence lands; other streams do not rewrite it.
- `docs/campaigns/babel-reliability-2026-11/dispositions/README.md` carries the copy-paste header and an example.

The conformance suite (`npm --prefix babel-cli run test:harness-acceptance`) validates every disposition CSV that exists under `dispositions/` — W14 is the worked example and the only ledger today; each stream's CSV is validated as it lands. Checks: the W01–W14 declaration (unique IDs, issues, scopes, finding counts summing to 100), the filename/stream match, the shared header, the status vocabulary, the required evidence per row, and — when the register is present — that all 100 IDs are unique and assigned to declared workstreams in the declared counts. When the register is absent the register test reports **skipped**, never passed.

## PR reconciliation (refreshed 2026-11-18)

Exact heads were read with `gh pr view <n> --json state,headRefOid,mergeCommit`. Recheck before acting; a head or state can change after this record.

| PR | Observed state | Reconciled claim |
| --- | --- | --- |
| [#513](https://github.com/gthgomez/Babel/pull/513) | Merged, `198193b1` (ancestor of base) | Daemon queue/quarantine parity, model/verify contracts, argv verifier matching are in history. Their findings still need their own head reproduction and qualification. |
| [#514](https://github.com/gthgomez/Babel/pull/514) | Merged, `e9c87b07` (ancestor of base) | Documentation/comment accuracy batch. No behavior claim. |
| [#515](https://github.com/gthgomez/Babel/pull/515) | **Merged** `93c5e117` at 2026-11-18T14:15Z, head `835b0fc6`; **not** in base `90583d97` | Installed Windows repair verification. Main has advanced past this workstream's base; the owning stream must refresh its base and verify the integrated result rather than recoding it. |
| [#516](https://github.com/gthgomez/Babel/pull/516) | Open draft, head `5865bf08` | First-use/provider and overlapping worker files. Rebase against the integration head once; do not reimplement. |
| [#517](https://github.com/gthgomez/Babel/pull/517) | Open draft, head `d43e4db3` | Windows CI shards. W12 owns sequencing. |
| [#518](https://github.com/gthgomez/Babel/pull/518) | Merged, `90583d97` (current base) | Offline CI performance summaries. In history; not a release artifact. |
| [#519](https://github.com/gthgomez/Babel/pull/519) | Open draft, head `969259f9` | Workflow-attempt evidence. W12 owns sequencing. |
| [#520](https://github.com/gthgomez/Babel/pull/520) | Merged, `5fa7d9fa` (ancestor of base) | Desktop coalesced second-turn completion. Verify integrated source/installed desktop before closing W11 findings. |
| [#536](https://github.com/gthgomez/Babel/pull/536) | Open draft, head `a255ecdb` | Proposed public register and campaign docs. Still not merged; no page may claim a canonical reconciled register yet. |

No merges, pushes or review claims follow from this table.

**Sequencing rule for overlapping PRs.** #521 sequences cross-stream work and each shared contract has one primary author (see the campaign ROADMAP in PR #536). A merged PR does not close another stream's finding: the owning stream refreshes its base, reruns the relevant integration/negative controls on the integrated head, and only then records `merged` or later. #515 is the current example — it merged after this branch's base, so its owning stream must verify the integrated result rather than cite the PR.

## Private audit #164 (AR-05)

The sixth report lives in a private archive and is not reproducible from public source. Public pages may carry only non-exploitative summaries; no private material, counts-as-truth or canonical-status claim is copied here. The proposed public register reconciles six audits into 100 unique IDs and explicitly denies single-report canonicality. AR-05's count discrepancy remains **unverifiable from public evidence**; it is recorded as `historical`, not silently resolved.

## Keeping this honest

- Do not relabel a merged repair as qualified, released or closed without exact-artifact evidence.
- Do not edit another stream's findings, rows or claims; report the cross-stream need instead.
- Record the command, head SHA and observed result behind every disposition. Prose assertions are not evidence.
- Update this page only for the shared vocabulary or landing structure; per-stream status belongs in the ledgers.
