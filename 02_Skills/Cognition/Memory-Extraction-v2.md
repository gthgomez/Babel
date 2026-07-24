<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Memory Extraction (v2.0)

**Category:** Cognition
**Status:** Active
**Pairs with:** Run artifact inspection, local learning, retrospectives, and project-memory maintenance
**Activation:** Load when the task is to inspect completed runs, logs, chats, or execution reports and decide what durable project knowledge should be written to memory.

## Purpose

This skill turns ephemeral execution history into durable project intelligence without polluting memory with task status, obvious facts, or stale implementation detail.

Use it when the output should answer:

- What did this run teach future agents?
- Which lessons are reusable beyond this one task?
- What should be remembered, and what should be discarded?

## Workflow

### 1. Inspect the Evidence Surface

Read the smallest sufficient evidence set:

- run summary or outcome files
- execution reports and halt tags
- relevant diffs or changed files
- user-stated preferences from the task thread
- verification output that explains a non-obvious constraint

Do not infer memories from vibes. Every memory must trace to an observed artifact or explicit user statement.

### 2. Extract Only Durable Knowledge

Keep a candidate only if it fits at least one category:

- `architectural_invariant` — stable system rule, contract, layer ordering, data shape, or boundary
- `hard_won_fix` — bug fix or workaround that would be costly to rediscover
- `environment_gotcha` — repo, tooling, OS, CI, or dependency behavior that affects future execution
- `user_preference` — explicit preference likely to matter in future work
- `operational_protocol` — repeated workflow or verification sequence that prevents regressions

Reject:

- simple task completion status
- raw code snippets without a reusable pattern
- guesses about intent
- temporary branch, run, or timestamp facts
- secrets, credentials, tokens, private personal data, or data copied from third-party content

### 3. Compress to Memory Shape

Write each memory as one compact, future-actionable sentence. Include enough context to prevent misuse, but omit run trivia.

Good:

- "Babel CLI JSON-mode commands must keep machine-readable output on stdout only; warnings belong on stderr."
- "Project Android release work should run the Play Store compliance checks when manifest permissions change."

Bad:

- "The task passed."
- "Edited `foo.ts`."
- "The agent tried three things."

### 4. Assign Severity

Use:

- `high` — prevents data loss, security/compliance regression, expensive rediscovery, or release breakage
- `medium` — materially improves future execution quality or avoids known friction
- `low` — useful preference or context, but safe to forget

### 5. Emit Reviewable JSON

Return only this shape unless the caller asks for prose:

```json
{
  "memories": [
    {
      "topic": "short snake_case topic",
      "category": "architectural_invariant | hard_won_fix | environment_gotcha | user_preference | operational_protocol",
      "memory_content": "one compact durable memory",
      "impact_severity": "low | medium | high",
      "source": "run id, file path, or user-provided context"
    }
  ],
  "rejected_candidates": [
    {
      "candidate": "brief description",
      "reason": "why it should not be stored"
    }
  ],
  "reasoning": "brief explanation of the extraction boundary"
}
```

If nothing qualifies, return `"memories": []` and explain why in `reasoning`.

## Hard Rules

1. Never store secrets, credentials, access tokens, private personal data, or raw proprietary content as memory.
2. Never store task status as memory unless it encodes a durable protocol or invariant.
3. Never invent a memory that cannot be traced to evidence.
4. Never preserve large code blocks; summarize the reusable lesson instead.
5. Prefer fewer, higher-signal memories over exhaustive extraction.

---

## Boundaries — Do Not Overstep
- This skill provides Babel-specific cognitive and evidence handling patterns. It does not replace official documentation for the underlying frameworks or data formats.
- Version-specific guidance must be verified against current stable releases before use.

## Failure Behavior of This Skill
- **Referenced pattern or schema is outdated:** Flag as STALE. Recommend verification against current standards.
- **Guidance conflicts with another skill:** Activate `coherence-linter` to detect and resolve.

## Strategic Next Move
After every substantial response, end with one strategic next-move question.

## References
- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for hardening patterns.
- `skill_standards_currency_audit` (`02_Skills/Governance/Standards-Currency-Audit-v2.md`) — for scheduled re-verification.
- `coherence-linter` (`04_Meta_Tools/coherence-linter/SKILL.md`) — for detecting contradictions.

---

**OLS-MCC Compliance:** v2.0 adds Boundaries, Failure Behavior, Strategic Next Move, and meta-tool references. Migrated 2026-06-20 per Phase 4 Tier 3 Migration — Block 4 (Cognition & Evidence).
