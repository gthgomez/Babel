<!--
status: ACTIVE
last_verified: 2026-09-30
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
