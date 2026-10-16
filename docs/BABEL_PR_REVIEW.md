<!--
status: ACTIVE
last_verified: 2026-10-16
-->
# Babel PR Review

Technical reference for review evidence. Contributor review/merge policy is owned
only by [AGENTS.md](../AGENTS.md#independent-review-and-merge). This file adds no
startup checklist or authorization. The optional command surface is documented in
[the review skill](../.agents/skills/babel-pr-review/SKILL.md).

## GitHub enforcement

The base-rooted gate reads the live ruleset, checks exact-head CI and its producer,
base freshness, PR state, and resolved threads. It reports custom review evidence
separately: absent or invalid advisory evidence remains absent or invalid.
It does not manufacture approval or grant permission. GitHub's merge endpoint
performs the final authorization and applies branch protection.

These are separate observations: contributor instructions expect independent
review; the gate reports evidence actually observed; the live GitHub ruleset
determines required approvals and checks. Missing advisory evidence never means
that an independent review happened. Optional Babel certification does not replace
ordinary independent review, and an unavailable certification capability must
remain unavailable rather than being reported as successful.

Base freshness is measured by ancestry, independently of whether strict freshness
is required. A nonstrict stale candidate may proceed only when integration evidence
is readable and sensitive exact-path overlap is clear. This heuristic cannot detect
semantic conflicts across different files. Strict policy still rejects stale
ancestry. The merge wrapper rereads the live head and base after the audit; a base
advance requires qualification again, including under nonstrict policy. GitHub's
expected-head merge protects the head; this is not an atomic compare-and-swap of
the base between the final read and merge.

## Optional orchestrated certification

The existing V3 producers and validators remain available for testing Babel's
review orchestration, fresh execution tracking, coverage, custody and stronger
isolation claims. Their capability requirements apply to their own evidence
contract; they are not prerequisites for the ordinary GitHub review workflow.
Legacy V2 and V3 implementation details remain in prior Git revisions.

## Trusted execution

The immutable base's evaluator supplies the merge decision. Candidate changes
cannot authorize their own promotion; the gate and merge wrapper retain that
boundary. Historical migration details are available in prior revisions.

## Finding evidence and revision history

Structured findings drive the returned review, including cached results. A valid
path and line establish `LOCATION_VALID`, not a real bug. For nonempty findings the
controller launches a separate read-only process with a fresh snapshot and no prior
conversation to try to falsify the claims. Its exact finding set, provider/model
observations, completion, and source excerpts are checked before a claim becomes
`SOURCE_SUPPORTED` or `SOURCE_REFUTED`. These are source assessments, not execution
proof. The worker cannot build or run tests; `REPRODUCED` requires separately
obtained actual execution evidence. An inconclusive or mislocated serious claim
remains visible and blocking. Refuting findings alone does not turn a previous
BLOCK or uncertain review into approval; a fresh complete review is required.

The extra process runs only for findings, sequentially after the initial review.
Its calls, failures, usage, and source assessments remain in private artifacts and
are included in review summaries. No live benchmark result is implied by the
deterministic tests of this integration.

Private revision history separates immutable observation IDs from defect identity.
Fingerprint version 2 preserves path case and uses symbol, defect class, and behavior
when supplied; otherwise only matching normalized claims are linked. Different
wording is not automatically the same defect. Legacy fingerprints remain legacy
observations and are not silently remapped. Changed trusted source invalidates old
review caches. Missing findings on a revision mean `not_observed`, never `fixed`.

The host-side `tools/babel-pr-adjudicate.mts` records may add optional
`defect_lifecycle` metadata:
`state` (`fixed`, `not_reproduced`, `pre_existing`, or `dismissed`), a `reason`,
`dependency_paths`, and optional `supersedes_defect_id`. These remain explicitly
`operator_recorded_not_independently_verified`, with their evidence references.
Dependency changes reopen dispositions and preserve their reasons; unavailable
comparison evidence cannot preserve them as current. Supersession links do not
erase observations or merge distinct bugs. History is advisory and grants no
merge authority.

## Benchmark and CI limits

Reviewer benchmark input is an allowlist of content-derived opaque ID, files,
candidate diff, and scope. Names, categories, difficulty, splits, answer keys,
and future evaluator fields stay evaluator-only. Reviewer failures are failures,
not clean approvals. The ten deterministic fixtures exercise wiring; they do not
establish production precision, recall, or parity with another review product.
Unlabeled real defects remain unknown until evidence supports an adjudication.

A clean Node 22.19.0/npm 10.9.3 dependency preflight runs before the full CI fanout.
The existing matrices and protected aggregators remain mandatory for that lane;
security and policy jobs still run if the preflight fails. Documentation-only
changes retain the existing fast lane.
