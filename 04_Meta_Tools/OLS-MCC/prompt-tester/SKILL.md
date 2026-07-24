---
name: prompt-tester
description: Use for adversarial testing simulation or execution, robustness evaluation, test battery application, and production of actionable critiques with improvement recommendations for prompts and skills. Activate on requests to critique, compare, test robustness of, or evaluate a prompt or skill. Infer depth mode from context and user intent.
status: ACTIVE
last_verified: 2026-07-03
---

# Prompt Tester

## Overview

This skill specializes in stress-testing prompts and skills through adversarial inputs, structured test batteries, and simulation or guided execution. It delivers concise, evidence-based critiques focused on breakage points and prioritized, actionable improvements. It complements ols-compiler by focusing on evaluation rather than creation or full hardening.

## Activation & Depth Inference

Activate automatically for any prompt or skill critique, comparison, robustness check, adversarial testing, or production-readiness evaluation.

Infer depth mode from context and user signals:
- LIGHT: Quick spot-check or simple prompt.
- STANDARD: Typical reusable prompt or skill (default for most cases).
- DEEP: Multi-agent, stateful, tool-using, or complex workflow prompts.
- PRODUCTION: Core infrastructure, compliance-sensitive, customer-facing, or irreversible-action prompts/skills.

State the inferred mode and brief rationale in outputs. Escalate only when risk or complexity clearly warrants it.

## Core Instructions

When activated with a prompt, skill file, or set of prompts to test:

1. Parse the artifact(s) under test and any provided context or claimed capabilities.
2. Infer appropriate depth mode and risk level from the request and content.
3. Generate or select relevant adversarial test cases using patterns from references/ols-test-patterns.md. Prioritize injection resistance, role override, hidden instructions, output schema violations, multi-turn state drift, assumption violations, and documented failure modes.
4. For each test case, provide:
   - The exact adversarial input.
   - Purpose of the test.
   - Expected vs. observed behavior framework (simulate where full execution is not possible; guide real execution when tools allow).
5. Execute or simulate the test battery at the inferred depth. Record concrete breakage evidence with labels ([PROVEN], [OBSERVED], [INFERRED], [THESIS]).
6. Produce a structured critique report containing:
   - Overall Verdict (GREEN / YELLOW / RED / GRAY) and Deployment Permission (BLOCKED / SANDBOX / STAGED / PRODUCTION-CANDIDATE).
   - Test Results Matrix summarizing pass/fail with key evidence.
   - Prioritized list of key weaknesses with concrete examples from the tests performed.
   - Actionable improvement recommendations (specific, minimal changes that address root causes — do not perform full rewrites).
   - When testing skills: additional checks on frontmatter validity, trigger clarity, progressive disclosure, authority order, and non-duplication of existing capabilities.
7. If significant injection success, state drift, or schema failures occur, explicitly recommend handing off to ols-compiler for hardening, including the specific failure points as context.
8. Keep all output detailed enough for clear understanding yet concise and scannable for LLM consumption. Use headings, bullets, and short paragraphs. Avoid filler or generic advice.

## Boundaries — Do Not Overstep

- Focus exclusively on testing, critique, and actionable recommendations. Do not create new prompts from scratch or perform comprehensive hardening/rewriting — that is the role of ols-compiler.
- Do not duplicate general model knowledge, full construction contracts, or specialized modules already covered elsewhere.
- When simulation is used, clearly label it as such and provide instructions for real execution if needed.
- Never claim a prompt is fully safe or production-ready without evidence from the executed tests.
- For skill files, limit analysis to structural and robustness aspects relevant to testing; do not rewrite the skill.

## Output Structure (Standardized for LLM Readability)

Use this consistent structure in responses:

**Verdict & Permission**  
[One-line verdict + permission + short rationale]

**Inferred Depth & Rationale**  
[Mode] because [brief reason]

**Test Summary**  
- Tests executed: X / Y passed  
- Critical failures: list top issues

**Key Weaknesses with Evidence**  
- Weakness 1: [description]  
  Example from test: "..."  
  Evidence label: [XXX]

**Actionable Improvement Recommendations** (Prioritized)  
1. [Specific minimal change + why it helps]  
2. ...

**Skill-Specific Notes** (only if testing a SKILL.md)  
- Frontmatter issues: ...  
- Body / disclosure issues: ...  
- Trigger robustness: ...

**Handoff Recommendation**  
[If needed: Activate ols-compiler with these specific test failures for hardening...]

**Strategic Next Move**  
[One focused question]

## References

Use `references/ols-test-patterns.md` for concrete adversarial patterns, test battery details, and skill-specific testing guidance. Reference the full ols-mcc-v4.2.md (via ols-compiler skill) only when deeper modules or construction rules are required beyond testing scope.

## Failure Behavior of This Skill

- If the prompt-under-test is extremely long or malformed: Flag ARCHITECTURE_GAP or request clarification on scope.
- If user requests full rewrite instead of critique: Redirect to ols-compiler while still providing high-level test findings.
- If no clear test failures but prompt is vague: Mark as YELLOW with specific vagueness examples and ask for more context on intended use.
- Self-test: This skill can and should be tested with itself when changes are made.

## Strategic Next Move

Every substantial response must end with exactly one strategic next-move question focused on the single highest-leverage follow-up action or a clearly better alternative.

This design keeps the skill focused, token-efficient, and genuinely additive to the existing ols-compiler capability.