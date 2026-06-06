<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Uncertainty Triage (v1.0)

**Category:** Cognition
**Status:** Active
**Pairs with:** All domains and session types
**Activation:** Load when the task is ambiguous, evidence is incomplete, the model is unsure how to proceed, or any mid-task confusion arises.

## Purpose

This skill provides a single decision point for confusion and uncertainty. It classifies the type of uncertainty and routes to the correct first move — before the model improvises, guesses, or emits an unstructured "I'm not sure" response.

Use it as the first step whenever a model notices it does not know how to proceed.

## The Four Uncertainty Types

| Type | Signal | First Move |
|------|--------|------------|
| `EVIDENCE_GAP` | Required file, schema, or data is missing or unseen | Gather the missing evidence; do not plan against guesses |
| `SCOPE_AMBIGUITY` | Two valid interpretations of the task lead to materially different outcomes | Ask one scoped clarification question; do not pick an interpretation silently |
| `CONFIDENCE_GAP` | You have evidence but it is indirect, stale, or conflicting | Tag confidence explicitly; expose the gap; give verification path |
| `REASONING_LOOP` | A plan was made, executed or reviewed, and returned a result you cannot resolve | STOP; do not patch blindly; return to PLAN with the failure evidence intact |

## Triage Protocol

### Step 1 — Classify

Identify which type applies. If more than one applies, take the highest-priority type in this order: `EVIDENCE_GAP` → `SCOPE_AMBIGUITY` → `CONFIDENCE_GAP` → `REASONING_LOOP`.

### Step 2 — First Move

Execute exactly the first move for your classified type:

- `EVIDENCE_GAP`: Inspect or request the missing artifact. Do not produce a plan until the gap is closed.
- `SCOPE_AMBIGUITY`: Ask one clarification question. State the two interpretations and ask which is intended. Do not ask multiple questions.
- `CONFIDENCE_GAP`: Label the uncertain claims explicitly using the confidence scale from `skill_epistemic_calibration` if loaded, or at minimum state "LOW CONFIDENCE — [reason]" before any recommendation.
- `REASONING_LOOP`: STOP. Emit the confusion report (see `OLS-v10-Core-Universal.md` §8 or the HALT report from `skill_autonomous_agent_state_machine` if in unattended mode). Return to PLAN. Do not re-attempt the failed approach without a changed assumption.

### Step 3 — Do Not Proceed Until the Type is Resolved

A classified uncertainty type is not resolved by ignoring it, hedging around it in prose, or adding a caveat and continuing. Resolution requires the evidence, the clarification answer, the confidence tag, or the plan revision.

## Hard Rules

1. Never silently pick one interpretation when `SCOPE_AMBIGUITY` is active.
2. Never plan against unseen content when `EVIDENCE_GAP` is active.
3. Never present `CONFIDENCE_GAP` claims as facts by omitting their uncertainty labels.
4. Never attempt a second fix in `REASONING_LOOP` before returning to PLAN.
5. Never emit more than one clarification question per uncertainty event.
