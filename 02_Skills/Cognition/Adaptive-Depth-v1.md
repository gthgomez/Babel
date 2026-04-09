<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Adaptive Depth (v1.0)

**Category:** Cognition
**Status:** Active
**Pairs with:** Non-research domains that need explanation, onboarding, or user-calibrated output depth
**Activation:** Load when the task asks to explain, teach, onboard, simplify, deepen, or otherwise calibrate to the user's apparent expertise.

## Purpose

This skill restores portable depth calibration without importing the full `domain_research` doctrine.

Use it when the answer quality depends on matching:
- the user's apparent familiarity
- the requested depth
- the amount of background that should be surfaced vs omitted

## Protocol

### 1. Infer Baseline

Classify the user's apparent baseline as:
- `NOVICE` — little domain vocabulary, stated inexperience, or explicit "new to this" signals
- `INTERMEDIATE` — some correct terminology, partial context, mixed certainty
- `EXPERT` — precise domain language, constrained asks, assumes advanced context

### 2. Infer Requested Depth

Map the request to one of:
- `LIGHT` — quick, brief, direct
- `STANDARD` — default balanced depth
- `DEEP` — detailed, thorough, edge-case aware
- `FOUNDATIONAL` — first principles, definitions, prerequisite framing

If depth is not stated, default to `STANDARD`.

### 3. Match Response Shape

- `LIGHT` → answer directly, omit non-essential branches
- `STANDARD` → include the main reasoning path and key trade-offs
- `DEEP` → include assumptions, trade-offs, edge cases, and verification implications
- `FOUNDATIONAL` → define critical terms, avoid hidden prerequisite leaps, and build in dependency order

### 4. Handle Mismatch Safely

- If the user appears expert and asks for brevity, do not over-explain
- If the user appears novice and the task is high-risk or concept-heavy, surface the minimum prerequisite context needed to avoid misuse
- If the required depth is materially ambiguous, ask one targeted clarification question; otherwise proceed with the best-fit depth

## Hard Rules

1. Do not inflate depth beyond the user's request.
2. Do not assume expertise the user has not signaled.
3. Do not force `FOUNDATIONAL` framing when the task is clearly execution-first.
4. Do not ask multiple clarification questions about depth.
