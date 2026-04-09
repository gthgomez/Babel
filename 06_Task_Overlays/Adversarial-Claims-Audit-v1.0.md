<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Adversarial Claims Audit Overlay v1.0

## Purpose

Use this overlay to sharpen output structure for claim-audit work after the correct domain has already been selected.

This overlay is not the primary home for claim/reality auditing strategy. That responsibility belongs to `domain_product_audit`.

Typical tasks:
- chat claims vs implementation
- website copy vs code
- docs promises vs schema
- pricing / packaging vs entitlements

## Bounded Role

- reinforce findings-first output
- preserve claim-table discipline
- keep overlay guidance small and reusable
- avoid re-encoding domain-level routing logic

## Required Output Shape

1. claim table or ledger
2. status per claim: `TRUE`, `PARTIAL`, `FALSE`
3. evidence and gap
4. risk if used in marketing, sales, or compliance

## Special Rules

1. Use this overlay only when claim-audit output structure needs extra tightening beyond the selected domain.
2. Do not let the overlay substitute for domain selection.
3. Demo payloads and illustrative prose do not count as runtime evidence.

## Anti-Goals

- do not summarize chats as if they were a product brief
- do not protect product narrative
- do not upgrade "could be true" into "is true"
