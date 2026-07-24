<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Memory Curation Patterns — Memory Curator Skill

**Purpose:** Detailed classification taxonomy, promotion criteria, dedup heuristics, and worked examples for the memory-curator skill.

---

## 1. Scope Classification Taxonomy

### Decision tree

```
Insight discovered during/after a run
  │
  ├─ Is this insight about a specific codebase, file, or project config?
  │   └─ YES → PROJECT scope. Keep in .babel/project_memories.md
  │
  ├─ Could another project under /workspace-root/ benefit from this insight?
  │   ├─ NO → PROJECT scope
  │   └─ YES → continue
  │
  ├─ Is the insight tool-, platform-, or process-specific (not project-specific)?
  │   └─ YES → WORKSPACE scope. Promote to /workspace-root/memory\
  │
  ├─ Does the insight describe a pattern that has already bitten 2+ projects?
  │   └─ YES → WORKSPACE scope (even if the trigger was project-specific)
  │
  └─ Unclear → UNCLEAR. Default to PROJECT; flag for human review.
```

### Classification examples

| Insight | Scope | Rationale |
|---------|-------|-----------|
| "example_saas_backend Stripe webhook handler must verify `stripe-signature` before reading body" | PROJECT | Specific to example_saas_backend's Stripe integration |
| "Supabase Edge Functions timeout at 150s regardless of `maxDuration` — plan jobs accordingly" | WORKSPACE | Affects any project deploying to Supabase Edge Functions |
| "Godot `export_presets.cfg` contains absolute paths — do not commit it" | WORKSPACE | Affects all Godot projects under the workspace |
| "Kivy `user_data_dir` is the correct config save path on Windows, not `AppData\Roaming`" | WORKSPACE | Cross-project UI framework knowledge |
| "Babel CLI pipeline.ts `buildExecutorTask` now requires `recoveryContext` field" | PROJECT | Babel-internal infrastructure knowledge |

### Proximity test

If removing the project name from the insight makes it incomprehensible → PROJECT.
If the insight remains fully actionable without any project context → WORKSPACE.

---

## 2. Promotion Criteria

### When to promote from `.babel/project_memories.md` to `/workspace-root/memory\`

Promote when ALL of:
1. Insight is classified WORKSPACE (see taxonomy above).
2. Insight has been validated in at least one completed run (has a `source_run_id`).
3. Insight is not already present in `/workspace-root/memory\` (check before writing).
4. Insight does not contain secrets, tokens, PII, or sensitive paths.

### When NOT to promote

- The insight is less than 24 hours old (let it settle — single-run insights can be noisy).
- The insight is contradicted by another run's evidence (flag for review instead).
- The insight is trivial ("remember to run `npm install` after pulling").

### Promotion format

Write to `/workspace-root/memory\<YYYY-MM-DD>.md`:

```markdown
## <Topic>

`DECISION:` <One-line actionable takeaway>
`EVIDENCE:` <Supporting details, commands run, file paths, commit hashes>
`SOURCE:` <source_run_id from .babel/project_memories.md or pipeline run>
`PROJECTS:` <List of projects this applies to or was observed in>
`STALENESS:` <Date after which this should be reviewed for currency>
```

If today's file already exists, append. If it would duplicate an existing entry in any workspace file, skip.

---

## 3. Deduplication Heuristics

### Detection

Two entries are likely duplicates if:
1. **Topic match**: Headings or first sentences share >70% word overlap (after stop-word removal).
2. **Action match**: Both recommend the same concrete action (same command, same config change, same code pattern).
3. **Failure match**: Both describe the same failure mode with the same root cause.

### Resolution

When duplicates are found:
1. **Same project, same insight**: Keep the more recent entry. Add a "Re-confirmed: <date>" note to the kept entry.
2. **Different projects, same insight**: STRONG signal for WORKSPACE promotion. Merge into one workspace entry with `PROJECTS:` listing both.
3. **Same topic, contradictory conclusions**: Flag as CONFLICT. Do not merge. Present both with evidence labels and ask user to resolve.

### False positive tolerance

If uncertain whether two entries are truly duplicates (borderline similarity), keep both with a `[THESIS]` cross-reference: "See also: <other entry> — may be related."

---

## 4. Stale Detection Rules

### Default staleness thresholds

| Memory type | Stale after | Rationale |
|-------------|-------------|-----------|
| API / library version guidance | 90 days | APIs change slowly |
| Bug workaround / hotfix | 60 days | Fix may be applied upstream |
| Config / environment gotcha | 180 days | Environment constraints persist |
| Process / workflow pattern | 365 days | Process knowledge has long shelf life |
| Model / LLM behavior observation | 30 days | Models update frequently |
| Tool-specific quirk | 90 days | Tools update but less frequently than models |
| Security / auth pattern | 60 days | Security guidance should be reviewed regularly |

### Staleness actions

- **Within threshold**: No action. Entry is current.
- **Past threshold, never referenced**: Flag for pruning. Offer to delete.
- **Past threshold, referenced recently**: Mark for review (not deletion). The entry is used but may contain outdated specifics. Offer to re-validate.
- **Multiple entries on same topic, some stale**: Keep the most recent, cross-reference from older entries pointing to the current one.

---

## 5. Worked Examples

### Example 1: EXTRACT after a multi-iteration pipeline run

**Run:** `20260619_143022_a1b2c3_refactor-executor-loop`

**Execution report shows:** 4 SWE-QA loops before executor loop bug was resolved. Root cause: `executorRecovery.ts` had a stale import path from the Phase 1 refactor.

**Extracted memory (auto):**
```markdown
## Stale import in executorRecovery.ts after Phase 1 refactor
- **impact**: high
- **source_run_id**: 20260619_143022_a1b2c3_refactor-executor-loop
```

**Curator classification:** PROJECT. This is specific to Babel's TypeScript source layout. Do NOT promote.

### Example 2: EXTRACT with workspace-scoped insight

**Run:** `20260618_091500_d4e5f6_EXAMPLE_SAAS_BACKEND-webhook-timeout`

**Execution report shows:** Supabase Edge Function timed out at 150s despite `maxDuration: 300` in config. Root cause: Supabase hard-caps Edge Function duration at 150s regardless of function config.

**Extracted memory (auto):**
```markdown
## Supabase Edge Function hard timeout is 150s
- **impact**: high
- **source_run_id**: 20260618_091500_d4e5f6_EXAMPLE_SAAS_BACKEND-webhook-timeout
```

**Curator classification:** WORKSPACE. Any project deploying Supabase Edge Functions needs to know this. Promote to `/workspace-root/memory\2026-06-18.md`.

### Example 3: SYNC with cross-project dedup

**SYNC scan finds:**
- `.babel/project_memories.md` (example_saas_backend): "Supabase RLS policy on `subscriptions` table must include `auth.uid() = user_id` in USING clause" (2026-06-10)
- `.babel/project_memories.md` (example_web_audit): "RLS policy on `audit_logs` table: always add USING (auth.uid() = user_id)" (2026-06-15)

**Dedup result:** Same pattern (RLS USING clause), different tables. Merge into workspace entry:
```markdown
## Supabase RLS policies must include auth.uid() in USING clause

`DECISION:` Every RLS policy on user-scoped tables must include `auth.uid() = user_id` in the USING clause. Missing this means users can see other users' rows.
`EVIDENCE:` Confirmed on `subscriptions` table (example_saas_backend, 2026-06-10) and `audit_logs` table (example_web_audit, 2026-06-15).
`PROJECTS:` example_saas_backend, example_web_audit
`STALENESS:` 2026-12-15
```

### Example 4: RETRIEVE before a task

**Task:** "Harden the example_saas_backend consent webhook handler against duplicate Stripe events"

**RETRIEVE query:** "Stripe webhook idempotency duplicate event supabase edge function"

**Results (top 3):**
1. [2026-06-18] [WORKSPACE] "Supabase Edge Function hard timeout is 150s" — relevant: the handler runs in an edge function; timeout affects idempotency window.
2. [2026-06-10] [PROJECT] "Stripe webhook signature verification must happen before body read" — relevant: security prerequisite for any webhook hardening.
3. [2026-05-25] [PROJECT] "Idempotency keys for Stripe payment capture" — partially relevant: same idempotency pattern, different endpoint (payments vs consent).

**Context injection:** "Three prior memories are relevant: (1) Edge Functions timeout at 150s — your idempotency window must fit within this. (2) Stripe signature verification must come first — no processing before verification. (3) Prior idempotency work on payments used `IdempotencyKey` header — consider reusing that pattern."
