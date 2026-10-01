<!--
status: ACTIVE
last_verified: 2026-09-30
-->
# Babel PR Review

GitHub permissions authorize merges. Reviewers can come from any harness or
model; Babel's custom certification subsystem is optional advisory tooling.

## Review workflow

1. Freeze the PR's current base and head and inspect the complete diff.
2. Launch a separate reviewer when available, supplying the diff, source, task
   intent, and test results. The same model is acceptable in a separate execution.
3. Publish actual findings in a normal PR comment or native GitHub review, with
   the reviewed SHA and limitations. No custom JSON receipt is required.
4. Repair findings and recheck the new head. Keep earlier rejection evidence.
5. Wait for required CI and inspect live GitHub branch rules. Merge with an
   expected-head check through an account that has merge permission.

Do not fabricate sandbox, process, provider, coverage, or supervisor claims.
Instructions restricting a reviewer to reading do not prove OS-level isolation.
An agent's access to repository metadata does not prove it can merge.

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

## Policy migration

This policy becomes active after its base-rooted gate reaches main. The old
main workflow cannot adopt candidate policy before that promotion. The maintainer
must deliberately migrate the existing custom-certification requirement; do not
pretend candidate scripts can authorize themselves under the older evaluator.
Normal security, content, Linux, Windows and metadata checks remain required.
