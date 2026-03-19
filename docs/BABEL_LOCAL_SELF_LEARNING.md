# Babel Local Self-Learning

## Goal

Make Babel Local improve from repeated use without allowing silent prompt drift.

The right model is:
- learn from outcomes
- stage proposed improvements
- require human review before prompt changes

The wrong model is:
- let Babel rewrite its own core rules automatically
- let one noisy session mutate the shared stack
- treat short-term model quirks as permanent truth

## Current Building Blocks Already In The Repo

Babel already has two useful foundations for a safe learning loop:

- `babel-cli/chronicle.sqlite`
  Local persistent memory for project-scoped facts.
- `babel-cli/scripts/evolve_prompts.ts`
  A proposal generator that reads run outcomes and stages prompt-evolution suggestions for human review.

This means Babel does not need a brand-new learning system.

It needs a tighter Local Mode feedback loop around tools you already have.

## Recommended Local Learning Loop

### 1. Capture session outcomes

For each Babel Local session, record:
- project
- task category
- model and client surface
- selected stack
- whether the user overrode the stack
- whether the task succeeded
- why the run failed or drifted

Good fields:
- `project_root`
- `task_category`
- `client_surface`
- `selected_stack_ids`
- `user_override_reason`
- `result`
- `failure_tags`
- `follow_up_needed`

### 2. Store stable facts in Chronicle

Use Chronicle for things that are likely to stay true for a while.

Examples:
- preferred Codex adapter for a repo
- repo has a local `LLM_COLLABORATION_SYSTEM`
- Gemini CLI sees the repo well enough for research but not edits
- Claude Code needs shorter kickoff prompts in a specific workflow

Do not store:
- raw conversation text
- sensitive code
- model outputs that have not been reviewed

Chronicle should remember operational facts, not blindly archive sessions.

### 3. Track failures as structured events

When Local Mode fails, normalize the reason into tags instead of free-form notes.

Useful tags:
- `stack_misselection`
- `repo_context_missing`
- `tool_visibility_gap`
- `instruction_overload`
- `model_ignored_overlay`
- `prompt_too_long`
- `repo_local_rules_won`

This is what makes later learning possible.

### 4. Generate proposed improvements, not direct edits

Periodically review the accumulated failures and generate:
- adapter adjustments
- better invocation snippets
- stronger task-overlay recommendations
- tool-profile updates
- missing-doc recommendations

Use staged outputs first:
- docs
- proposal JSON
- change suggestions

Do not auto-commit prompt changes from Local Mode.

### 5. Require human approval for rule changes

Any change to:
- `prompt_catalog.yaml`
- router behavior
- Behavioral OS rules
- model adapters
- project overlays

should stay human-reviewed.

The Local learning loop should help humans decide faster.
It should not become a self-editing black box.

## What Babel Local Should Learn First

The highest-value Local Mode learning targets are:

### Invocation quality

Learn which startup phrase works best by client:
- Codex extension
- Claude Code
- Gemini CLI
- VS Code chat surfaces

### Stack defaults

Learn which adapter and overlay combinations work best for:
- frontend refactors
- backend bugs
- research tasks
- repo review

### Repo integration patterns

Learn whether a repo:
- has a local collaboration system
- needs extra startup files
- has recurring invariant handoff failures

## Safe Implementation Path

### Phase 1

Add structured session logging for Babel Local runs.

Implemented starting point:
- `tools/log-local-session.ps1`

Still recommended:
- `docs/TOOL_PROFILES.md`

### Phase 2

Teach the resolver and local tooling to read Chronicle facts and recommend:
- preferred adapter
- preferred invocation length
- known repo-local handoff order

### Phase 3

Run a periodic proposal job that summarizes:
- repeated resolver overrides
- repeated task-overlay misses
- client-specific drift patterns

The output should be a human-review artifact, not a silent edit.

## Guardrails

- Never auto-edit `01_Behavioral_OS` from Local Mode.
- Never auto-edit the router from one run outcome.
- Never promote a repo-specific fact into a global rule without review.
- Never store secrets, proprietary code, or raw customer data in Chronicle.
- Always verify that a proposed rule improves more than one run before adopting it.

## Success Criteria

Babel Local is learning well when:
- kickoff prompts get shorter over time
- stack overrides become less common
- model switching causes fewer repo-invariant mistakes
- the same task resolves to better defaults across tools
- approved prompt changes are backed by repeated evidence
