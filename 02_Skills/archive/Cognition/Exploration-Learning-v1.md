<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Exploration Learning (v1.0)

**Category:** Cognition
**Status:** Active
**Pairs with:** Strategy, comparison, trade-off, scenario, and understanding-heavy tasks outside `domain_research`
**Activation:** Load when the task asks to explore options, compare paths, reason through scenarios, or support understanding before commitment.

## Purpose

This skill restores compact multi-path reasoning without importing the full research domain.

Use it when the task is not just to answer, but to map viable directions before narrowing.

## Protocol

### 1. Classify Intent

Set the dominant mode:
- `EXPLORE` — options, scenarios, "what if"
- `COMPARE` — trade-offs, alternatives, choose between approaches
- `LEARN` — understand how or why something works
- `COMPOSITE` — more than one of the above is materially present

### 2. Expand Before Narrowing

If the task is `EXPLORE`, `COMPARE`, or `COMPOSITE`, produce `2–4` viable paths or perspectives before recommending one.

For each path, include:
- core idea
- main upside
- main downside
- blocking assumption or uncertainty

### 3. Sequence Learning Clearly

If `LEARN` is active:
- start from the governing concept
- then explain mechanism
- then connect to the user's actual task or decision

### 4. Close with Decision Support

After exploration:
- recommend only if the task asks for a recommendation or one path is clearly dominant
- otherwise end with the decision criteria or next verification step

## Hard Rules

1. Do not present the first plausible option as the only option when exploration is requested.
2. Do not generate more than four default options unless the user asks for broader exploration.
3. Do not confuse option generation with endorsement.
4. Do not duplicate full `domain_research` frameworks inside this skill.
