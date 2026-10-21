# Passage integrity verification acceptance (PREP)

This file is **preparation only**. It is not an executable test suite and does not assert acceptance.

Canonical production contract (Agent A): optional `PassageRecord.integrity_verification` on passages written through `appendPassage`, tied to `source_fetch_owner` and the successful fetch attempt. B will add reciprocal tests under `passageIntegrityVerification.*.reciprocal.test.ts` after merging A’s published API.

Authoritative matrix: [`../../../../review-artifacts/b-passage-integrity-verification-acceptance-prep.md`](../../../../review-artifacts/b-passage-integrity-verification-acceptance-prep.md)

Receipt bindings JSON: [`../../../../review-artifacts/b-passage-integrity-verification-receipt-bindings.prep.json`](../../../../review-artifacts/b-passage-integrity-verification-receipt-bindings.prep.json)

Withdrawn (not production): parallel `trustedPassageVerification*` port/handoff/harness from an earlier mistaken B slice.
