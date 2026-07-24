<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Dynamic Context Injector (v1.1)

**Category:** Meta Tools
**Status:** Active
**Layer:** `04_Meta_Tools/` — augments V9 orchestrator Step C skill selection
**Pairs with:** `ols-compiler`, `prompt-tester`, `skill-auditor`, `ops-observability` (OBSERVE mode), V9 orchestrator
**Activation:** Load this skill when assembling a Babel instruction stack for a task — after the orchestrator produces candidate skills but before the manifest is finalized. Also load when auditing token budgets or debugging context bloat in multi-agent runs.

---

## Purpose

The V9 orchestrator's Step C selects skills by static rules: domain defaults, platform presets, and hard-coded triggers. This works for known patterns but has two failure modes at scale:

1. **Over-inclusion:** Domain defaults load skills irrelevant to the *specific* task, consuming token budget and diluting model attention.
2. **Under-inclusion:** A skill highly relevant to the task's actual content is missed because no static rule triggers it.

This skill adds a semantic relevance pass between orchestrator selection and manifest finalization. It scores every candidate skill against the task description, filters by a configurable threshold mode, and emits a minimal refined manifest. The result: fewer tokens, sharper attention, and fewer "why didn't it load X?" postmortems.

This directly addresses the #1 community pattern gap identified in the OLS-MCC audit roadmap: dynamic guideline injection with relevance routing (Parlant-style).

---

## Activation & Mode Inference

Infer when to activate:
- The orchestrator has produced a candidate skill set and the task is complex (DEEP or PRODUCTION depth).
- The user asks to optimize, trim, or audit the instruction stack for a specific task.
- A multi-agent run experienced attention decay, cost overruns, or irrelevant skill activations.
- Token budget is tight and selective loading matters.

**Threshold modes** (infer from context, state explicitly in output):

| Mode | Behavior | Use when |
|------|----------|----------|
| `CONSERVATIVE` | Keep all domain defaults + add high-relevance extras | High-stakes, compliance, novel domains, first pass |
| `BALANCED` (default) | Drop domain defaults below relevance threshold; add high-relevance extras | Typical production work, most tasks |
| `AGGRESSIVE` | Only skills above a strict relevance threshold; no default safety net | Tight token budget, well-understood domain, quick tasks |

**Rule:** Never use AGGRESSIVE for PRODUCTION-depth safety-critical tasks (auth, payments, compliance, irreversible mutations) unless the user explicitly requests it and understands the risk.

---

## Core Instructions

When activated with a task description and a candidate skill set:

### Step 1 — Ingest Candidates

From the orchestrator's Step C output (or a provided manifest), extract:
- The task description (user's exact words + task classification + purpose_mode)
- Each candidate skill's `id`, `description`, `tags`, and domain default status
- The domain architect ID and purpose_mode

If the candidate set is not available, load it from `prompt_catalog.yaml` using the domain's `default_for_domains` entries plus any orchestrator step-C rules that fired.

### Step 2 — Score Relevance

For each candidate skill, assign a relevance score (0.0–1.0) based on:

| Signal | Weight | How to evaluate |
|--------|--------|-----------------|
| **Semantic match** | 40% | Does the task description semantically overlap with the skill's purpose and activation triggers? Compare task verbs/entities/domain to skill description. |
| **Tag alignment** | 25% | Do the skill's catalog tags intersect with task-relevant concepts? (e.g., task mentions "webhook" → skills tagged `utility:webhook` get boost) |
| **Domain default strength** | 20% | Is this skill a domain default for the matched domain? (defaults get a baseline, but not a free pass) |
| **Orchestrator rule specificity** | 15% | Did a specific orchestrator rule fire for this skill (e.g., "Android TV" → `skill_android_tv_game_ux`)? Specific rules carry more weight than generic defaults. |

**Scoring guidelines:**
- 0.0–0.3: No meaningful overlap. The skill addresses a different domain or problem class.
- 0.4–0.6: Partial overlap. Some concepts align but the skill is tangential.
- 0.7–0.8: Strong overlap. The skill directly addresses concepts in the task.
- 0.9–1.0: Essential. The task cannot be completed correctly without this skill.

Label every score with an evidence label:
- `[KNOWN]` — backed by explicit task-skill term overlap
- `[INFERRED]` — reasonable inference from task context but no direct term match
- `[THESIS]` — speculative; could go either way

### Step 3 — Apply Threshold

Filter based on the selected mode:

| Mode | Keep if score ≥ | Notes |
|------|----------------|-------|
| `CONSERVATIVE` | 0.3 | Also keep ALL domain defaults regardless of score |
| `BALANCED` | 0.5 | Domain defaults below 0.5 are dropped with justification |
| `AGGRESSIVE` | 0.7 | No default safety net; every skill must earn its place |

**Hard rules (override all thresholds):**
- Skills tagged `config:always_load` are **always kept** regardless of score.
- Autonomous governance skills (`skill_untrusted_input_guard`, `skill_autonomous_agent_state_machine`, `skill_async_task_delivery`) are always kept when `pipeline_mode = "autonomous"` — these are safety-critical, not relevance-gated.
- `skill_workspace_locking` is always kept when `pipeline_mode = "parallel_swarm"`.
- Skills with a relevance score below 0.2 are **always dropped** regardless of mode — they have no plausible connection to the task.

### Step 3.5 — AgentDropout-Style Redundancy Elimination

After threshold filtering, apply a redundancy elimination pass inspired by AgentDropout (ACL 2025). Skills that pass the relevance threshold but serve overlapping functions are candidates for dropout.

**Redundancy detection**:
1. For each kept skill, compare its description and tags against every other kept skill.
2. If two skills share ≥2 tags AND their descriptions overlap semantically (both cover the same concept area), flag the pair as potentially redundant.
3. For each redundant pair, keep the higher-scoring skill and drop the lower-scoring one UNLESS:
   - The lower-scoring skill covers a concept area no other kept skill covers
   - The skills have a declared `pairs_with` relationship (they're designed to co-activate)
   - Dropping would leave a safety gap (skills tagged `governance:safety` or `config:always_load`)

**Dropout reporting**: Add a "Redundancy Drops" section to the output:
```
Redundancy Drops (M skills):
  [skill_id] (score: X.X) → dropped as redundant with [skill_id] (score: Y.Y)
    Overlap: [shared tags and concept areas]
    Rationale: [why the kept skill covers this area and why dropping is safe]
```

**Efficiency target**: In BALANCED mode, aim for ~20% further token reduction from redundancy elimination beyond threshold filtering. In CONSERVATIVE mode, detect redundancy but keep both skills with a [REDUNDANT] flag instead of dropping. In AGGRESSIVE mode, aggressively eliminate all detected redundancies.

**Evidence basis**: AgentDropout (ACL 2025) demonstrated that eliminating redundant agents improves both token efficiency (21.6% prompt reduction) and task performance (+1.14 avg). Skill-level redundancy elimination follows the same principle: redundant skills consume token budget without adding unique information.

### Step 4 — Detect Gaps

After filtering, scan for under-inclusion risks:

1. **Missing safety skills:** If the task involves mutations, external calls, or state transitions, flag if `skill_ops_observability` (or equivalent safety skills) were dropped.
2. **Missing domain-essential skills:** If the task squarely matches a domain but a core skill was filtered out, flag it with rationale.
3. **Unexpected gaps vs orchestrator rules:** If an orchestrator rule explicitly fired for a skill that was then dropped, flag the conflict.

Gap flags do NOT automatically re-add the skill — they surface the decision for human or agent review.

### Step 5 — Emit Refined Manifest

Produce a structured output (see below). Include the full refined skill list, dropped skills with reasons, gap flags, and token budget impact estimate.

---

## Output Structure

Use this consistent structure in every response:

```
DYNAMIC CONTEXT MANIFEST
────────────────────────
Task: [1-line summary]
Domain: [domain_id] | Purpose: [purpose_mode]
Mode: [CONSERVATIVE / BALANCED / AGGRESSIVE]
Rationale: [1-line reason for mode choice]

Skill Relevance Scores:
  [score]  [skill_id]  [evidence_label]  [1-line rationale]
  ...

Refined Manifest (KEPT — N skills):
  1. [skill_id]  (score: X.X, reason: ...)
  ...

Dropped (M skills):
  [skill_id]  (score: X.X)  → dropped because [specific reason tied to task content]
  ...

Redundancy Drops (P skills):
  [skill_id] (score: X.X) → dropped as redundant with [skill_id] (score: Y.Y)
    Overlap: [shared tags]
  ...

Gap Flags:
  ⚠ [gap description + recommended action]  (or "None — all essential skills retained")

Token Budget Impact:
  Before: ~N tokens across M skills
  After:  ~N tokens across K skills
  Saved:  ~N tokens (X%)
  Estimate based on token_budget values in prompt_catalog.yaml

Integration:
  Feed this refined manifest into the V9 orchestrator's instruction_stack assembly.
  After execution, activate ops-observability in OBSERVE mode to compare actual
  skill activations against this refined manifest — flag any drift.
```

---

## Boundaries — Do Not Overstep

- **This skill scores and filters — it does not create new skills or modify skill content.** Hand off to `ols-compiler` for skill creation or hardening.
- **This skill augments, not replaces, the V9 orchestrator Step C.** The orchestrator owns domain routing and static rule selection. This skill refines the candidate set it produces.
- **Do not override safety-critical rules.** Skills tagged `always_load`, autonomous governance skills, and swarm locking must never be dropped regardless of relevance score.
- **Do not make the AGGRESSIVE mode decision unilaterally for PRODUCTION tasks.** If the task is safety-critical and the user hasn't specified a mode, default to BALANCED.
- **This skill is a meta-tool for stack assembly — not a runtime hook.** It runs at manifest-build time, not during model execution.

---

## Failure Behavior of This Skill

- **No candidate skills available (orchestrator didn't produce any):** Flag the gap. Return an empty manifest with a recommendation to re-run orchestrator Step C or manually provide candidates.
- **All skills score below threshold in BALANCED mode:** Escalate to CONSERVATIVE mode with an explicit note. A task that triggers no skills is likely misclassified — re-check domain routing.
- **Multiple skills score identically at the threshold boundary:** Keep borderline skills with a [THESIS] note. Defer to OBSERVE mode post-execution to determine if they were actually needed.
- **Contradiction with orchestrator rule:** Flag the conflict explicitly in Gap Flags. Do not silently override — surface it.
- **Self-test:** This skill should be tested with prompt-tester against known task/skill pairs where the correct inclusion/exclusion set is known. It should also be audited by skill-auditor after any structural change.

---

## References

- `references/relevance-scoring-patterns.md` — detailed scoring heuristics, edge cases, multi-domain ambiguity handling, and worked examples.
- `prompt_catalog.yaml` — canonical source for skill descriptions, tags, token budgets, and `default_for_domains` mappings.
- `00_System_Router/OLS-v9-Orchestrator.md` Step C — the skill selection rules this module augments.
- `ops-observability` (OBSERVE mode) — post-execution verification that the skills loaded match the refined manifest and were actually relevant.

## Strategic Next Move

After every manifest emission, end with exactly one strategic next-move question: ask whether to proceed with the refined manifest, adjust the threshold mode, or activate OBSERVE mode post-execution to validate the relevance decisions against actual runtime behavior.

---

**Design note:** This skill implements the #1 community pattern gap from the OLS-MCC audit roadmap: dynamic guideline injection with relevance routing. v1.1 adds AgentDropout-style redundancy elimination (2026-06-27) for further token reduction. It follows the OLS-MCC triad pattern — lean activation layer, structured evidence-labeled output, explicit Boundaries, Failure Behavior, and handoff contracts to ols-compiler, ops-observability, and the V9 orchestrator. Place it in `04_Meta_Tools/` alongside the OLS-MCC triad; promote to `01_Behavioral_OS/` only if it becomes a permanent pre-manifest hook in all Babel pipeline runs.
