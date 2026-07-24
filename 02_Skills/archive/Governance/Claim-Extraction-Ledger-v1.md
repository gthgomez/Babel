<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Claim Extraction Ledger (v1.0)

**Category:** Governance
**Status:** Active
**Pairs with:** `domain_research`, `domain_compliance_gpc`, `pipeline_qa_reviewer`
**Activation:** Load for chat-export audits, marketing-copy verification, competitive teardowns, or any task that must extract claims from prose before verifying them.

## Purpose

Do not verify against a blur of impressions. First turn source material into an atomic claim ledger.

This skill exists for tasks where the source of truth is messy:
- chat exports
- decks
- landing pages
- docs pages
- strategy memos
- sales copy

Without a ledger, verification drifts into summary. This skill prevents that.

## Step 1 — SOURCE REGISTER

List every claim-bearing source before extraction:

| Source ID | Type | Scope | Notes |
|-----------|------|-------|-------|
| `[src]` | [chat / page / doc / deck / code comment] | [full / partial] | [date, export, constraints] |

If a source is a chat export, treat assistant prose as claim-bearing text and user questions as claims only when the user explicitly asserts something.

## Step 2 — ATOMIC EXTRACTION

Extract only meaningful claims.

A meaningful claim is any statement about:
- implementation
- capability
- performance
- security
- compliance
- pricing / packaging
- competitive differentiation
- coverage / scope

Split compound claims. Example:
- "We detect navigator.globalPrivacyControl and record immutable edge PoP logs"
- becomes two or more claims, not one.

## Step 3 — CANONICAL LEDGER

Normalize each extracted item into:

| Claim ID | Category | Claim Text | Source ID | Source Ref | Scope / Qualifier |
|----------|----------|------------|-----------|------------|-------------------|
| `[id]` | [runtime / evidence / pricing / legal / competitive / scanner / other] | [atomic claim] | `[src]` | [quote or location] | [every request / per site / today / enterprise / etc.] |

Preserve temporal and scope qualifiers exactly:
- "today"
- "every request"
- "for Pro"
- "before any data flows"

These qualifiers usually determine whether the claim survives verification.

## Step 4 — DEDUPE WITHOUT BLURRING

Merge only truly equivalent claims.

Do not collapse:
- implementation claims into positioning claims
- endpoint-level claims into whole-system claims
- "records events" into "immutable audit proof"

If two sources use different scope, keep both rows.

## Step 5 — HANDOFF TO VERIFICATION

The verifier should receive:
- the claim ledger
- the source register
- the categories with the highest overclaim risk

Recommended output framing:
- extracted claims first
- verification second
- narrative summary last

## Hard Rules

1. Extraction is not verification. Do not mark claims true or false during ledgering.
2. A question is not a claim unless it embeds an assertion.
3. Preserve absolutes such as "all", "every", "immutable", "before", and "guaranteed".
4. Split architecture claims from marketing analogy.
5. If a sentence mixes fact and hype, isolate the factual core and the hype tail as separate rows.
