<!--
status: ACTIVE
last_verified: 2026-10-10
skill_package: skills/session-retro/
-->
# Session Retro (v1.0)

## Purpose
A blameless, evidence-first retrospective performed by the agent on its own
work. Triggered (a) at the end of every coding session, or (b) immediately
after an agent error, failed run, wasted effort, or false report. Converts
session experience into persistent improvements so the same failure class is
not repeated. The output is not an apology; it is root-cause analysis plus
system changes.

## Rules
1. **Critic stance**: review the transcript as if reviewing another agent's
   PR — hunting for claimed-without-verified, thrash, ignored signals, and
   false reports. Never narrate; audit.
2. **Evidence first**: every finding must quote a concrete artifact — the
   verbatim command/output, `file:line`, or diff hunk. Label evidence
   `[PROVEN]` / `[OBSERVED]` / `[INFERRED]` / `[UNKNOWN]`. Re-run a failing
   command when cheap and side-effect-free. If evidence is unavailable, the
   root cause is `unknown` with the missing evidence named — never invented.
3. **5-Whys into a fixed taxonomy**: trace each issue until the cause lands in
   exactly one category — R (reasoning/plan), V (verification gap),
   T (tooling/environment), C (stale/missing context), D (data/state lineage
   misread), U (unknown). "I made a typo" is not a root cause; keep asking
   why it was not caught. Distinguish strategic errors (wrong plan) from
   tactical errors (right plan, wrong execution).
4. **Bounded output**: per-issue record = title, severity (P1 false
   report/data-loss risk, P2 wasted rework, P3 friction), category, evidence,
   why-trace, fix applied now, persistent lesson. Session-end mode caps at 3
   lessons and ~30 lines; report what went well / went poorly / got lucky.
5. **Lessons are directives, not observations**: "tests were failing" is
   banned; "run `<check>` before claiming `<success>`" is the format.
6. **Persistence**: write each lesson to the agent memory system (feedback
   entry with Why/How-to-apply) or the project instructions file; full records
   to a greppable retro log (`category: V severity: P1 date: YYYY-MM-DD`).
   Before writing a new lesson, search existing memory/lessons — near-
   duplicates update the existing entry.
7. **Recurrence escalation**: a cause appearing a second time is promoted from
   prose to a mechanical guard — lint rule, pre-commit check, CI step, or
   script fix — built in the same session, not deferred.
8. **Blameless**: neither self-flagellation nor "user error". Ambiguous
   requirements are recorded as "allowed two readings — ask X first next
   time".

## Verification
- Every finding cites at least one quoted artifact.
- Every why-trace terminates in exactly one taxonomy category.
- Each lesson is an imperative directive with an application condition.
- Persistence targets were actually written (memory/index/instructions file),
  or the retro states why not.

## Boundaries — Do Not Overstep
- This skill governs self-review and lesson persistence. It does not govern
  the delivery of results to humans (`skill_async_task_delivery`), handoff
  artifacts (`skill_agent_handoff_protocol`), or the substantive engineering
  work being reviewed.
- It does not authorize instruction-file amendments by itself: policy files
  are amended only per the repo's own agent-policy rules.

## Failure Behavior of This Skill
- Evidence unavailable → root cause recorded as `unknown` with the gap named;
  no fabricated causes.
- Clean session → three-line retro; do not invent issues to justify the
  ritual.
- Lesson cannot be made actionable → record as observation in the retro log
  only; do not pollute memory or instructions files.
