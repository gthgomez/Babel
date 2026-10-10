# session-retro

Blameless, evidence-first retrospective skill for coding agents. Investigates
why an agent error or failure happened — through the agent's own eyes — and
turns the findings into persistent improvements: memory entries, instruction
updates, or mechanical guards.

## When it runs

- **On-error postmortem:** immediately after an agent mistake, failed run,
  wasted effort, or false report. Deep, single-failure analysis.
- **Session-end retro:** at the close of every coding session. Lightweight
  (SRE triad + at most 3 lessons).

## What it produces

Per issue: severity (P1–P3), root-cause category (Reasoning / Verification
gap / Tooling / Context / Data-lineage / Unknown), an evidence quote, a 5-Whys
trace, the fix applied now, and a persistent lesson phrased as an actionable
directive. Lessons land in the agent memory system or the project instructions
file; recurring causes get escalated to mechanical guards (lint rules, CI
checks, script fixes) instead of prose.

## Contents

- `SKILL.md` — the operating procedure (modes, evidence rules, taxonomy,
  output format, persistence targets, anti-patterns).
- `references/example-retro.md` — fully worked example applied to a real
  session, including the recurrence-escalation note.

## Prompt bridge

Babel catalog id `skill_session_retro`; prompt-layer owner
`02_Skills/Governance/Session-Retro-v1.md`.
