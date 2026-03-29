<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# NAMIT Research Critique

## Purpose

Reference note for prompt authors working on edge-case and QA frameworks inside Babel.

## Summary

NAMIT is a Babel-local mnemonic, not an industry-standard software framework.

Use it as a compact review checklist, not as a claim of external standardization.

## Recommended Position

Use a hybrid approach:
- broader test-planning frameworks for scenario coverage
- NAMIT for compact code-level and prompt-level edge-case checks

## Practical Guidance

Interpret the letters as:
- N: null or missing input
- A: array or boundary size conditions
- M: concurrency or shared-state behavior when relevant
- I: input validation, coercion, and injection risk
- T: timing, retries, latency, or timeout behavior when relevant

## Caution

Do not force NAMIT categories that do not apply to the task.

Good use:
- code review
- QA review
- bounded plan validation

Bad use:
- pretending NAMIT is an external compliance framework
- padding plans with irrelevant checklist items
