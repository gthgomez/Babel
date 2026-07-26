# Babel Status & Verification Index

<!--
status: ACTIVE
last_verified: 2026-07-26
-->

> **Role**: Live status matrix, product decision locks, and evidence ledgers.

## Active Status References

| Document | Description |
| :--- | :--- |
| [BABEL_PUBLIC_OSS_QUALIFICATION_2026-07-26.md](./BABEL_PUBLIC_OSS_QUALIFICATION_2026-07-26.md) | **OSS qualification**: Public repo ready for active product work; PR #20 merge + CI evidence. |
| [claims-matrix.md](./claims-matrix.md) | **Claims Ledger**: Evidence-backed ledger of supported, unsafe, and experimental features. |
| [BABEL_PRODUCT_DECISION_LOCK.md](./BABEL_PRODUCT_DECISION_LOCK.md) | **Product Lock**: Active product decisions, boundaries, and 30-45 day roadmap locks. |
| [BABEL_COMPETITIVE_GAP_REPORT_2026-06-15.md](./BABEL_COMPETITIVE_GAP_REPORT_2026-06-15.md) | **Competitive Analysis**: Benchmark comparisons against external coding agents. |

## Remaining document / hygiene work (planned)

| Priority | Item | Notes |
| :--- | :--- | :--- |
| Medium | Port sanitized `BABEL_BIBLE.md` enhancements from private history | Mode selection, design philosophy, overlay guidance — only after scrub |
| Low | Port `tui-competitive-audit` skill | Requires competitor-name sanitization before public |
| Low | Optional `.claude/settings.json` credential deny rules | Behavioral rule 09 + CI already cover most risk |
| Low | Batch-3 audit leftovers | `@internal` JSDoc, duplicate OLS docs, GTM skill review, emoji cleanup |

## Archived Status Documents

Historical evals, daily worker audits, and remediation checklists are archived under docs/archive/status/.
