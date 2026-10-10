---
name: session-retro
description: >
  Investigate why an agent error or failure happened through the agent's own
  eyes, and turn session experience into persistent improvements. Use at the
  end of every coding session ("retro", "retrospective", "wrap up", "what did
  we learn"), immediately after any agent mistake, failed run, wasted work,
  false report, or when the user asks "why did that happen", "what went
  wrong", "don't do that again", or "investigate yourself". Also use
  proactively whenever you notice you claimed something without verifying,
  thrashed on a tool, or had to redo work.
---

# Session Retro

A blameless, evidence-first retrospective performed by you, the agent, on your
own work. The output is not an apology — it is root-cause analysis plus
persistent changes that make the next session measurably better. Two modes:

- **On-error postmortem** (one failure, deep): trigger immediately when a
  mistake or failure is detected.
- **Session-end retro** (lightweight): trigger at session close or when asked.

Pick the mode, then follow the steps. Do not skip the evidence step — a
retrospective from memory alone rationalizes; one from quoted artifacts
corrects.

## Prompt bridge

- **Babel catalog id:** `skill_session_retro`
- **Prompt-layer owner:** `02_Skills/Governance/Session-Retro-v1.md`
- Use the prompt skill for Babel stack assembly; use this package for the
  worked example and the full per-issue output format.

## 1. Establish the critic stance

Review your own transcript **as if reviewing another agent's PR**. Direct
self-review invites rationalization, so deliberately adopt the critic role:
you are hunting for where this agent claimed without verifying, thrashed,
ignored a signal, overrode a constraint, or reported something false. You are
not narrating what happened.

## 2. Gather evidence (never skip)

For each candidate issue, collect at least one concrete artifact:

- the actual command or tool call and its **verbatim** output/error;
- `file:line` references for code mistakes (quote the wrong line);
- the diff hunk that introduced the problem;
- timestamps or turn numbers to establish sequence.

If the evidence is gone (output not saved, transcript truncated), say so and
mark the root cause `unknown — evidence not retained` rather than inventing
a cause. Re-run a failing command if it is cheap and side-effect-free. Label
each evidence item the Babel way: `[PROVEN]` (verbatim quote), `[OBSERVED]`
(clear pattern), `[INFERRED]` (flag as weaker), `[UNKNOWN]` (missing).

## 3. Trace to a root cause (5 Whys, fixed taxonomy)

For each issue, ask "why" until the cause lands in exactly one of these
categories — stopping at the first plausible cause is the failure mode this
step exists to prevent:

| Code | Category | Example |
|------|----------|---------|
| R | Reasoning/plan error | Assumed entry chunk = app code; wrong plan for the edit |
| V | Verification gap | Reported success without running the check; verifier never validated against a known-positive |
| T | Tooling/environment misuse | Wrong tool params; unscoped search; ignored a tool's precondition |
| C | Stale/missing context or instructions | Didn't read the file before editing; used outdated memory |
| D | Data/state lineage misread | Treated legacy data as a live code bug |
| U | Unknown | Evidence unavailable — name what's missing |

A cause like "I made a typo" is not a root cause — keep asking why ("why was
the typo not caught?" → "no post-edit verification step" → category V).

Distinguish **strategic** errors (wrong plan — needs a different approach) from
**tactical** errors (right plan, wrong execution — needs a check). Their
remedies differ.

## 4. Write the retro output

Keep it bounded: on-error mode covers 1–3 issues; session-end mode caps at 3
lessons and ~30 lines total. Use this per-issue format:

```markdown
### [P1] <short title>  (category: V, tactical)
- **What happened:** <1–2 sentences>
- **Evidence:** <quoted command/output or file:line>
- **Why (trace):** A → B → root cause in category X
- **Fix applied now:** <what was corrected in this session, if anything>
- **Persistent lesson:** <directive, see step 5>
```

Severity: P1 = produced or nearly produced a false report or data loss;
P2 = wasted meaningful time or caused rework; P3 = friction worth a habit
change. Include a one-line **"what went well / what got lucky"** pair in
session-end mode (SRE triad: went well / went poorly / got lucky).

## 5. Persist lessons — the whole point

A retro that only lives in chat is a diary entry. For each issue, write a
**persistent lesson** as an actionable directive — never an observation:

- Banned: "Tests were failing." "Should have been more careful."
- Required: "Grep all loaded SPA chunks for the feature string before
  declaring a deploy missing; validate the verifier against a known-present
  marker first."

Where to persist, in order of preference:

1. **Agent memory system** (if available): one `feedback`-type memory per
   transferable lesson, with `**Why:**` and `**How to apply:**` lines, and
   update the memory index.
2. **Project instructions file** (`AGENTS.md`/`CLAUDE.md`-equivalent) for
   lessons that apply to this repo every session — but check the file's
   policy on amendments first; do not commit instruction changes without
   authorization.
3. **Retro log** (`docs/retros/` or similar, if the project keeps one): the
   full per-issue records, with a greppable header line
   (`category: V severity: P1 date: YYYY-MM-DD`) so recurrence can be
   detected.

**Recurrence check (do this before writing any new lesson):** search existing
memory/lessons for the same root-cause category or pattern. If this is a
repeat (2nd+ occurrence), escalate the remedy: promote the prose lesson to a
mechanical guard — a lint rule, a pre-commit check, a CI step, or a checklist
item in the project's instructions. Lessons that keep recurring as prose are
retro failures.

## 6. Close the loop immediately

If a lesson can be enforced by code rather than remembered, build the guard
now (this session, not "later"): the script fix, the lint rule, the test.
Then report back to the user in one short block: issues found (with
severity/category), lessons persisted (and where), guards added, and what
remains open.

## Anti-patterns

- **Ceremony on clean sessions.** If nothing nontrivial went wrong, the
  session-end retro is three lines and done. Do not invent issues to justify
  the ritual.
- **Blame language.** Neither "I failed" nor "user error". Reframe ambiguity
  as "the requirement allowed two readings — next time ask X first".
- **Kitchen-sink retros.** Every friction is not a lesson. If a fix wouldn't
  change future behavior, drop it.
- **Unbounded lesson files.** Before adding a lesson to a shared instructions
  file, check whether an existing entry already covers it — update that one
  instead of appending a near-duplicate.

For a fully worked example of this format applied to a real session, read
`references/example-retro.md`.
