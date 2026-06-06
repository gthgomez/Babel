<!--
Babel Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Skill: Agent Documentation Architecture (v2.0)
**Category:** Governance
**Status:** Active
**Activation:** Load when a repo needs cold-start agent navigation, AGENTS / CLAUDE / GEMINI / Copilot instruction routing, PROJECT_CONTEXT docs, stale-doc cleanup, docs-as-code checks, QA/release runbooks, or a compact source-backed documentation graph for no-context LLMs and human maintainers.

---

## Purpose

Design the smallest useful documentation graph for agents.

The goal is not "more docs." The goal is fast, truthful navigation: what this repo is, which files matter, which commands are trusted, what is risky, what is historical, and what remains unverified.

Short curated agent docs can reduce runtime tokens. Unnecessary context files can reduce success and increase cost. Treat every new startup file as a budget tradeoff.

Preserve v1 rules:

- source-backed claims only
- no invented architecture
- stale-doc classification before edits
- protected startup/context doc safety
- no secrets or credential values
- explicit verification gaps

---

## Step 0 - Prove Docs Are Needed

Create or modify docs only when at least one trigger is true:

- repeated agent confusion exists
- stale docs contradict source
- cold-start route is missing
- commands or high-risk zones are unclear
- release/testing workflow is unclear
- user explicitly requested docs

If none apply, report "docs not needed" and suggest a lighter action such as one README link or no change.

---

## Step 1 - Establish Authority

Use this hierarchy for documentation truth:

1. user's explicit current instruction
2. current source/config/migrations/manifests
3. passing command output from the current run
4. maintained docs marked CURRENT
5. recent linked evidence artifacts
6. historical docs
7. assumptions

Docs can route and summarize. They do not overrule source, current command output, or higher workspace policy.

---

## Step 2 - Inventory And Classify Docs

List documentation surfaces before editing:

- `README.md`
- `PROJECT_CONTEXT.md`
- `AGENTS.md`, `CODEX.md`, `CLAUDE.md`, `GEMINI.md`
- `.github/copilot-instructions.md`
- `.github/instructions/*.instructions.md`
- nested/package `AGENTS.md`
- `QA_CHECKLIST.md`
- `docs/README.md`
- release, deployment, troubleshooting, design, or research docs
- generated evidence artifacts

Classify every relevant doc with one label:

- `CURRENT_AUTHORITY` - maintained current context or routing doc
- `CURRENT_RUNBOOK` - maintained command/checklist workflow
- `GENERATED_EVIDENCE` - generated output from a run, screenshot pass, audit, or report
- `HISTORICAL` - old context retained for background only
- `ARCHIVE` - preserved but not part of the active workflow
- `DEPRECATED` - replaced by a newer maintained surface
- `DO_NOT_USE_AS_AUTHORITY` - misleading, generated, stale, unsafe, or untrusted

Protected startup/context docs require the applicable decommission/approval gate before deletion or consolidation.

---

## Step 3 - Define The Loading Contract

Assign one job per file. Avoid duplicate long content across tools.

| Surface | Role |
|---|---|
| `README.md` | Human quick start, scope, docs map, first commands. |
| `PROJECT_CONTEXT.md` | Source-backed architecture, boundaries, invariants, file map, current limitations. |
| `AGENTS.md` | Agent cold-start router: read order, high-risk zones, trusted commands, handoff contract. |
| `CODEX.md` | Legacy/local Codex adapter only when an existing workflow explicitly requires it; do not create by default or duplicate AGENTS. |
| `CLAUDE.md` | Claude Code context adapter; concise reminders and links, not a full copy of AGENTS. |
| `GEMINI.md` | Gemini CLI hierarchical context adapter; concise local routing and safety notes. |
| `.github/copilot-instructions.md` | Repo-wide Copilot defaults and coding style. |
| `.github/instructions/*.instructions.md` | Path-scoped Copilot instructions; short and specific. |
| nested/package `AGENTS.md` | Package-local overrides and hazards for that subtree only. |
| `QA_CHECKLIST.md` | Done definition and regression checklist. |
| `docs/README.md` | Index for multi-doc folders; current vs historical routing. |
| `.babel/docs-manifest.json` | Optional machine-readable routing and fitness metadata for complex repos. |

If multiple agents need the same rule, put the canonical text in one maintained surface and link from adapters.

For Codex-style routing, treat `AGENTS.md` as canonical. Use `CODEX.md` only for legacy or local launcher behavior that is already present and verified.

---

## Step 4 - Enforce Size Budgets

Budgets prevent context bloat. Exceed only with an explicit justification in the doc or final report.

| Surface | Budget |
|---|---|
| root `AGENTS.md` | 100-180 lines |
| `CLAUDE.md` | under 200 lines |
| nested/package `AGENTS.md` | 40-120 lines |
| `PROJECT_CONTEXT.md` | 250-500 lines unless justified |
| `QA_CHECKLIST.md` | 80-200 lines |
| `docs/README.md` | 40-100 lines |
| path-scoped instruction files | short and specific |

Use progressive disclosure:

- root docs route
- project docs explain
- package docs specialize
- runbooks verify
- generated artifacts prove

Treat platform context caps as real. If a project has Codex-style combined startup limits in the 32 KiB class, shorten adapters and route with links instead of copying content.

Do not front-load historical notes, long design essays, or generated reports into agent startup files.

---

## Step 5 - Verify Against Source

Before writing current-state docs, inspect the real implementation:

- package manifests and build files
- app or service entrypoints
- routers, adapters, and state management
- API clients and protocol boundaries
- database schemas, migrations, and persistence
- CI, release, install, and test scripts
- existing tests and QA artifacts

Facts in docs must trace to source, current command output, or explicit user instruction.

If a claim needs hardware, production, account, remote, or live-environment proof and you do not have it, mark it as unverified.

---

## Step 6 - Build The Minimal Graph

Prefer a small maintained set:

- `README.md`
- `PROJECT_CONTEXT.md`
- one agent router such as `AGENTS.md`
- `QA_CHECKLIST.md`

Add optional docs only when they have a maintained reader:

- `docs/release-testing.md`
- `docs/deployment.md`
- `docs/ui-target.md`
- `docs/troubleshooting.md`
- `docs/README.md`
- tool adapters such as `CLAUDE.md`, `GEMINI.md`, or Copilot instructions

Do not create broad marketing docs, duplicate adapters, or policy-like files with no owner.

---

## Step 7 - Optional Machine Manifest

For complex repos, add `.babel/docs-manifest.json` only when humans or tooling will maintain it.

Minimum shape:

```json
{
  "lastVerificationDate": "YYYY-MM-DD",
  "maintainedDocs": ["README.md", "PROJECT_CONTEXT.md", "AGENTS.md"],
  "historicalDocs": ["docs/archive/old-plan.md"],
  "trustedCommands": ["npm test", "npm run build"],
  "highRiskPaths": ["app/build.gradle.kts", "src/auth/"],
  "doNotUseAsAuthorityGlobs": ["artifacts/**", "docs/archive/**"],
  "maxLineBudgets": {
    "AGENTS.md": 180,
    "CLAUDE.md": 200,
    "PROJECT_CONTEXT.md": 500
  }
}
```

Do not add the manifest to small repos where it would become another stale file.

---

## Step 8 - Docs-As-Code Fitness Checks

Run or propose checks appropriate to the repo:

- linked paths exist
- trusted commands exist in package/build scripts or repo docs
- line budgets pass or have explicit justification
- stale phrases are flagged: "soon", "TODO later", "currently broken?", "old flow", "legacy maybe", "WIP" without owner
- historical docs have a visible header
- generated artifacts are not labeled as current truth
- no secrets, tokens, local credential values, private keys, or keystore passwords are documented
- docs map distinguishes current, historical, generated, and deprecated files

Prefer deterministic checks over manual review when the repo has CI or scripts.

---

## Step 9 - Cold-Start Eval

The proof mechanism is a no-context agent test. After the graph is updated, a fresh agent should answer:

- what is this repo?
- where do I start?
- what commands do I run?
- what files are risky?
- what docs are historical?
- what is unverified?
- what does done mean?

Score one point per answer. Pass requires 7/7 from maintained routed docs and zero blockers:

- no historical doc treated as current truth
- no invented command
- unverified claims remain marked unverified
- high-risk paths are identified
- done means build/test/release/QA criteria, not vibes

If the answer requires reading more than the routed docs or guessing from source, the graph is not done.

---

## Step 10 - Cleanup Rules

When stale or cluttered docs exist:

1. identify contradictions against source
2. preserve useful facts in the right maintained doc
3. mark retained stale docs as historical, archive, deprecated, or do-not-use
4. avoid deletion unless the approval/decommission rule allows it
5. keep migration notes short

If deletion is blocked, make the maintained route unmistakable.

---

## Future Skill Splits

If this skill grows, split deeper work into:

- `skill_agent_docs_minimal`
- `skill_agent_instruction_routing`
- `skill_docs_fitness_ci`
- `skill_cold_start_eval`
- `skill_docs_cleanup_deep`

Keep this skill as the compact architecture layer.

---

## Hard Rules

- Do not create docs without a maintained reader.
- Do not invent architecture, commands, support status, production readiness, or test coverage.
- Do not imply docs guarantee agent correctness.
- Do not let README/docs/specs overrule source or higher policy.
- Do not duplicate long content across `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and Copilot files.
- Do not hide debug signing, local-only credentials, experimental adapters, or live verification gaps.
- Do not document secrets or local credential values.
- Do not delete protected startup/context docs without the required approval flow.

---

## Output Shape

End with:

- docs graph changed
- budget/line checks
- source evidence inspected
- docs intentionally not added
- fitness checks run
- cold-start eval result or gap
- remaining stale/clutter risks
