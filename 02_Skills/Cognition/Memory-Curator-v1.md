<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Memory Curator (v1.0)

**Category:** Cognition
**Status:** Active
**Layer:** `02_Skills/Cognition/` — bridges project-level memory extraction with workspace-level curation
**Pairs with:** `skill_memory_extraction`, `babel-cli/src/services/memoryExtraction.ts`, `ops-observability` (OBSERVE mode)
**Activation:** Load after significant pipeline runs (EXTRACT mode), during periodic maintenance windows (SYNC mode), or when a task needs cross-project context (RETRIEVE mode).

---

## Purpose

Babel's `memoryExtraction.ts` service already extracts per-project memories from completed runs into `.babel/project_memories.md`. The CLI exposes `babel memory list/query/prune/log` commands. A separate workspace-level `/workspace-root/memory\` directory exists with 20+ human-written decision logs — but it is entirely disconnected from Babel's automated extraction.

This skill bridges the gap by orchestrating memory across projects and levels:

- **EXTRACT mode**: After a significant run, trigger extraction AND classify whether each memory is project-scoped or workspace-scoped. Workspace-scoped insights get promoted.
- **SYNC mode**: Periodically scan memory stores across projects, deduplicate, promote workspace-level insights to `/workspace-root/memory\`, and mark stale entries.
- **RETRIEVE mode**: On-demand query across both project and workspace memory stores for task-relevant context before starting work.

This directly addresses Phase 2.1 of the OLS-MCC audit roadmap: "Memory / Wiki / On-Demand Retrieval Primitives — Background sync jobs + selective vector/wiki query instead of stuffing everything into prompts."

---

## Mode Selection

Infer the mode from context. State it explicitly at the start of output.

| Signal | Mode |
|--------|------|
| A pipeline run just completed (status COMPLETE or equivalent) | **EXTRACT** |
| User asks to "curate memories", "sync memories", or "check for stale memories" | **SYNC** |
| User asks "what do we know about X?" across projects, or starts a task needing context | **RETRIEVE** |
| Periodic maintenance, end-of-session, or start-of-session | **SYNC** + **RETRIEVE** |
| Ambiguous | Ask: "EXTRACT (after a run), SYNC (maintenance), or RETRIEVE (gather context)?" |

---

## Mode: EXTRACT — After a Significant Run

### Activation

Activate after any pipeline run that:
- Modified code in a non-trivial way (>50 lines changed, or touched a high-risk zone)
- Encountered a novel error or failure mode
- Required a multi-iteration plan/verify/refine cycle
- Involved infrastructure, auth, compliance, or deployment changes

Skip for: single-line fixes, trivial renames, read-only research, or runs that failed before producing an execution report.

### Instructions

1. **Trigger extraction**: If the run artifacts are available (typically `runs/<run-id>/04_execution_report.json`), instruct the user to run `babel memory list` to confirm the extraction fired automatically, or manually trigger via the `extractAndSaveMemories()` path if it didn't.
2. **Load extracted memories**: Read `.babel/project_memories.md` for the current project. Find entries matching the current run's `source_run_id`.
3. **Classify scope**: For each new memory, classify:
   - `PROJECT` — Insight specific to this project's codebase, stack, or domain. Keep in `.babel/project_memories.md` only.
   - `WORKSPACE` — Insight applicable across projects (e.g., "CI runner auth tokens must be refreshed every 30 days", "Godot export_presets.cfg must not be committed"). Promote to `/workspace-root/memory\`.
   - `UNCLEAR` — Could go either way. Default to PROJECT; flag for review.
4. **Write workspace entry**: For WORKSPACE-scoped memories, write a new dated file or append to today's `/workspace-root/memory\<YYYY-MM-DD>.md` using the established format (## heading, `DECISION:`, `EVIDENCE:`, source run ID).
5. **Report**: List extracted count, promoted count, and any UNCLEAR items needing review.

Use the classification taxonomy and promotion criteria from `references/memory-curation-patterns.md`.

---

## Mode: SYNC — Periodic Maintenance

### Activation

Activate on:
- User request for memory maintenance
- Start-of-session or end-of-session (when user signals "I'm done for now" or "let's set up for today")
- After accumulating 10+ new entries in `.babel/project_memories.md` since last sync
- Weekly (suggest to user if it's been 7+ days)

### Instructions

1. **Scan project stores**: For each project under `/workspace-root/` that has a `.babel/project_memories.md`, read the file and note:
   - Total entry count
   - Newest and oldest entry dates
   - Entries marked for promotion that haven't been promoted yet
2. **Deduplicate**: Find near-duplicate entries within and across projects. Flag pairs with >80% semantic overlap. Offer to merge (keep the more detailed entry, add a cross-reference to the removed one).
3. **Promote pending**: Any entries classified WORKSPACE in EXTRACT mode but not yet written to `/workspace-root/memory\` — promote them now.
4. **Prune stale**: Entries older than the configured max age (default 30 days) that haven't been referenced — flag for pruning. Offer to run `babel memory prune` or the equivalent manual cleanup.
5. **Report**: Produce a sync summary — entries scanned, promoted, deduplicated, pruned, pending review.

---

## Mode: RETRIEVE — On-Demand Context

### Activation

Activate:
- Before starting a complex task that may benefit from prior learnings
- When the user asks "what do we know about X?" or "have we dealt with this before?"
- When a task matches a known failure pattern or high-risk zone

### Instructions

1. **Query both stores**: Search `.babel/project_memories.md` for the current project AND `/workspace-root/memory\` for workspace-wide entries matching the task keywords.
2. **Rank by relevance**: Score each match on:
   - Semantic overlap with task description
   - Recency (newer > older)
   - Impact severity (high > medium > low)
   - Source project (same project > adjacent project > unrelated project)
3. **Filter**: Present only the top-N most relevant entries (default N=5). Include entry content, source run ID, date, and scope classification.
4. **Inject as context**: Surface the relevant memories as context for the current task. If using Babel Local Mode, suggest adding them to the task's context preamble.
5. **Track utility**: Note which retrieved memories were actually used. This feeds back into the relevance scoring for future retrievals.

### Output Structure

```
MEMORY RETRIEVAL
────────────────
Task: [1-line summary]
Stores searched: [project .babel/] + [workspace /workspace-root/memory\]

Relevant Memories (top 5):
  1. [date] [scope] [topic] — [1-line content summary]
     Source: [run_id or file]
     Relevance: [HIGH / MEDIUM] — [1-line rationale]
  ...

Context Injection:
  [Suggested preamble or key insights to include in task context]

Utility Tracking:
  [After task: note which memories proved useful — feed back to retrieval scoring]
```

---

## Boundaries — Do Not Overstep

- **This skill orchestrates existing Babel memory infrastructure — it does not replace it.** Memory extraction is performed by `babel-cli/src/services/memoryExtraction.ts`. This skill tells you WHEN and WHY to run it, and how to classify/promote the results.
- **Do not extract memories mid-task.** Memory extraction runs on completed pipeline artifacts. Mid-task observations belong in the run's own execution log, not in persistent memory.
- **Never store secrets, tokens, or credentials.** The same rule from `skill_memory_extraction` applies here: filter any memory content containing keys, passwords, tokens, or PII before promotion.
- **Do not create new memory storage mechanisms.** Use `.babel/project_memories.md` (project) and `/workspace-root/memory\` (workspace) as the canonical stores. Do not invent new file formats, databases, or APIs for memory storage.
- **This skill is a cognition tool — not a compliance audit.** For compliance evidence bundles, use `ops-observability` OBSERVE mode.

---

## Failure Behavior of This Skill

- **No `.babel/project_memories.md` found for the current project:** The project hasn't completed any pipeline runs with memory extraction. Suggest running a significant task first, or offer to manually curate from chat logs.
- **`/workspace-root/memory\` directory doesn't exist or is empty:** Create it with a starter file explaining the format. Offer to bootstrap from existing `.babel/project_memories.md` entries across projects.
- **Memory store is extremely large (>200 entries):** Offer to prune before syncing. Large stores slow down retrieval. Suggest increasing the staleness threshold or switching to a more aggressive pruning schedule.
- **Duplicate detection is uncertain (borderline overlap):** Flag both entries with [THESIS] label, present evidence for both sides, and ask the user whether to merge or keep both.
- **No relevant memories found for a RETRIEVE query:** Report "No relevant memories found across [N] projects." This is a valid result — not every task has prior art. Suggest running the task and extracting memories afterward to build the knowledge base.
- **Self-test:** This skill should be used to curate its own creation session. After this file is committed, run in EXTRACT mode on the session that created it.

---

## References

- `references/memory-curation-patterns.md` — classification taxonomy, promotion criteria, dedup heuristics, stale detection rules, and worked examples.
- `skill_memory_extraction` (`02_Skills/Cognition/Memory-Extraction-v1.md`) — the extraction skill that produces structured memory entries from run artifacts. This skill orchestrates it.
- `babel-cli/src/services/memoryExtraction.ts` — the TypeScript service implementing extraction, reading, querying, and pruning. Understand its capabilities before orchestrating.
- `ops-observability` (OBSERVE mode) — for tracking whether retrieved memories were actually useful post-execution.

## Strategic Next Move

After any substantial EXTRACT, SYNC, or RETRIEVE output, end with exactly one strategic next-move question: for EXTRACT, ask whether to sync across projects; for SYNC, ask whether to retrieve context for the next task; for RETRIEVE, ask whether the surfaced memories changed the task approach.

---

**Design note:** This skill fills the Phase 2.1 gap from the OLS-MCC audit roadmap: cross-project memory curation with background sync and on-demand retrieval. It follows the OLS-MCC dual/tri-mode pattern established by Ops-Observability v2 (DESIGN/OBSERVE) and dynamic-context-injector (CONSERVATIVE/BALANCED/AGGRESSIVE). It integrates with — but does not duplicate — the existing `memoryExtraction.ts` service and `skill_memory_extraction` extraction skill.
