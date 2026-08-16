# GPT-5.6 Audit Chain — 2026-08

<!--
status: HISTORICAL
last_verified: 2026-08-15
-->
This directory preserves the GPT-5.6 audit chain as **revision-bound historical evidence**.
All three documents were produced on 2026-08-15 against a frozen revision; the first two
were deliberately uncommitted at production time (audit practice: audits are evidence, not
ship artifacts) and were relocated here as tracked historical evidence during the
2026-08-15 documentation reconciliation.

## Chronology

```text
01 architecture audit          →  02 cross-review           →  03 implementation report
BABEL_GPT56_BUILDER_ARCHITECTURE_AUDIT.md
      ↓ (feeds findings)
BABEL_GPT56_AUDIT_CROSS_REVIEW.md      (cross-review of five independent audit documents)
      ↓ (its verified findings drive)
BABEL_GPT56_CROSS_REVIEW_IMPLEMENTATION_REPORT.md  (what was implemented + validated)
```

## Freeze record

| Item | Value |
|------|-------|
| Date | 2026-08-15 |
| Base commit | `d92c02dbbc5bd5fb9940646fcb7a0aad2b70021c` on `fix/session-event-lifecycle-identity` |
| Working tree at audit time | **Dirty** (policy work in flight; autonomy policy files untracked; audit docs untracked) |
| External audits pinned at | `bcd975f9b43aaf6acac7b5894309e95aa051cd05` (main) where pinned at all |
| Node / npm | v24.12.0 / 11.19.0 |

## Reading these documents

- **01** is a read-only architecture audit against the GPT-5.6 builder guide: verdict
  `TARGETED_IMPROVEMENTS`, with four evidence-backed gaps (cache-blind prompts, unwired
  autonomy classifier, OpenAI-shaped provider contract with a DeepSeek-only live lane,
  routing evidence supporting tier reordering only).
- **02** is a cross-review that verifies/contradicts the claims of five independent audit
  documents against repo source at `d92c02d`. Its verdict legend:
  `VERIFIED` / `PARTIALLY VERIFIED` / `CONTRADICTED` / `UNSUPPORTED` / `UNVERIFIABLE`.
- **03** is the implementation report for the trust-boundary hardening that addressed the
  verified findings: all P0 items implemented and wired, P1 cluster implemented where
  evidence justified it, 287 tests passing, `npx tsc --noEmit` clean at report time.

## Authority notes

- **Old findings remain historically true for their frozen revision.** For example, the
  original finding that autonomy enforcement was unwired is valid historical evidence for
  `d92c02d` — do not edit the audits to pretend the problems were never present.
- **The implementation report may supersede findings as statements of current runtime
  behavior.** Where the report documents a subsequent fix (e.g. autonomy A–D wiring,
  `commandSemantics` classes, canonical outcome model), current behavior claims should be
  checked against the implementation report and the code, not against the older audit text.
- None of these documents is current product or architecture authority. Runtime norms:
  [HARNESS_ARCHITECTURE_V1.md](../../architecture/HARNESS_ARCHITECTURE_V1.md).
