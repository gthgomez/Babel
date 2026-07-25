<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
-->


<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# 2026-04-24 CLI Product Baseline

Source plan: `docs/plans/BABEL_CLI_PRODUCT_GAP_PLAN.md`

## Baseline Command

```powershell
npm --prefix .\babel-cli run benchmark:product
```

The command writes a dated artifact under `runs/benchmarks/` and covers:

- install/help startup
- first-five-minutes setup checklist
- first-run doctor JSON
- daily interactive slash-command discovery
- approval profile status
- dry-run safety status
- MCP v2 doctor status
- MCP untrusted external-content labeling
- evidence/latest-run status
- checkpoint/restore gap marker
- checkpoint/session command surface probes
- checkpoint restore CLI smoke regression
- shell/test-run filesystem-diff checkpoint coverage
- executor model-context session artifact
- web context policy/citation-capable executor tools
- MCP resource, prompt, and bounded tool-search executor surfaces
- runtime plugin trust-gated activation and doctor probe
- subagent/team contract and list probe
- Phase 5 interactive recovery parity probe
- `@file`/`@directory` context injection preview probe
- structured JSONL event stream contract probe
- richer run/session stats probe
- read-only CI review evidence probe
- draft-only Git delivery probe
- strict enterprise policy doctor probe
- public export dry-run safety probe
- local read-only schedule registry probe
- scheduled automation gap marker

Each scenario records the concrete `user_scenario`, the `benchmark_question` being answered, official-doc `market_sources`, and the Babel-specific `target_outcome`. Future phase agents should treat a missing source link as a benchmark quality bug.

## Post-Upgrade Top-3 Comparison

Refresh date: 2026-04-24 after roadmap Phases 0-10.

Latest local evidence:

```powershell
node .\babel-cli\dist\index.js benchmark product --json --output-dir $env:TEMP\babel-cli-current-compare --timeout-ms 20000 --max-output-bytes 2000
```

Observed result: 23 scenarios, 23 pass, 0 fail.

Official-doc market anchors refreshed:

- Claude Code: [overview](https://code.claude.com/docs/en/overview) covers terminal, IDE, desktop, and web surfaces; file edits, commands, MCP, skills, hooks, subagents/agent teams, Git workflows, CI/CD, schedules, and cross-surface handoff.
- Codex: [overview](https://developers.openai.com/codex/) covers app, IDE extension, CLI, web, GitHub/Slack/Linear integrations, MCP, plugins, skills, subagents, non-interactive automation, SDK, GitHub Actions, and enterprise administration.
- Gemini CLI: [overview](https://google-gemini.github.io/gemini-cli/) and [CLI docs](https://google-gemini.github.io/gemini-cli/docs/cli/) cover a terminal-first open-source agent with Google Search grounding, file/shell/web tools, MCP, extensions, slash commands, hierarchical memory, checkpoint restore, headless mode, sandboxing, IDE integration, telemetry, and enterprise configuration.

Comparative scorecard:

| Dimension | Babel after phases 0-10 | Claude Code | Codex | Gemini CLI | Read |
| --- | --- | --- | --- | --- | --- |
| First-run and discoverability | Strong local checklist, doctor, help, benchmark, public-release gate | Excellent polished install and multi-surface onboarding | Excellent CLI/IDE/web onboarding | Excellent fast terminal onboarding and free-tier path | Babel is now credible but less polished externally |
| Daily terminal UX | Good command map, REPL slash commands, JSON outputs, stats | Excellent | Excellent | Excellent | Parity is close for inspection/recovery; polish still trails |
| Recovery and safety | Strong checkpoints, restore refusal on user edits, session context, dry-run, isolated mutating schedules | Strong permission/worktree/checkpoint patterns | Strong sandbox/cloud isolation | Strong `/restore` checkpointing and sandboxing | Babel is competitive and more evidence-explicit |
| MCP and external context | Strong read-oriented MCP/resources/prompts/tool-search plus untrusted labels and web citation/cache policy | Excellent broad MCP and hook integration | Excellent MCP config and Codex-as-MCP | Strong MCP plus built-in Google Search/web tools | Babel is policy-strong but lacks HTTP/OAuth depth |
| Extensibility | Good plugin manifests, trust levels, hooks, prompt skills, MCP bundles | Excellent plugins/skills/hooks/subagents | Excellent plugins/skills/hooks/rules/subagents | Strong extensions/custom commands/MCP bundles | Babel is safe and coherent but ecosystem is tiny |
| Agent teams | Spec-contract harness with isolation/merge evidence; live LLM subagents disabled | Excellent live subagents and agent teams | Excellent explicit parallel subagents | Weaker than Claude/Codex for true agent teams | Babel trails until live subagents exist |
| Git, CI, delivery | Strong draft-first/read-only evidence; explicit local mutation gates | Excellent Git/PR/CI/scheduled workflows | Excellent GitHub/cloud review/delegation | Strong GitHub Action and automation patterns | Babel is safer by default but less integrated |
| IDE/app/cloud | Read-only event stream contract only | Excellent IDE/desktop/web/remote surfaces | Excellent IDE/web/cloud/app/GitHub surfaces | Good IDE companion | Babel trails clearly |
| Enterprise/admin/telemetry | Strong strict doctor, policy sources/fix hints, redaction, telemetry opt-in, policy packs | Strong managed settings/admin story | Strong enterprise/admin/cloud controls | Strong enterprise config/telemetry/trusted folders | Babel's differentiator is transparent policy evidence |
| Public/ecosystem readiness | Release validation and export dry-run are strong; public docs still need maintainer pass | Mature public product | Mature public product | Mature open-source ecosystem | Babel is not yet top-tier externally |

Overall rating against the top 3:

| Product | Current rating | Why |
| --- | --- | --- |
| Codex | 9.5/10 | Best all-around shipping loop: CLI, IDE, web/cloud, GitHub, parallel subagents, automation, and integrations. |
| Claude Code | 9.4/10 | Deepest mature agent-workflow surface: hooks, skills, subagents/agent teams, schedules, app/web/IDE handoff, and strong coding ergonomics. |
| Gemini CLI | 8.6/10 | Best open terminal baseline: free-tier access, huge context, built-in search/tools, checkpointing, extensions, sandboxing, and headless mode. |
| Babel CLI | 7.8/10 | No longer a prototype. It is strongest in governed execution, evidence, policy, dry-run/export safety, checkpoints, and deterministic review gates, but still trails on live model-agent quality, ecosystem, app/cloud/IDE surfaces, and public onboarding. |

Verdict:

- Babel is not yet a top-3 general coding agent CLI.
- Babel is now a credible specialist control plane for governed, evidence-backed, multi-model codebase work.
- The next highest-leverage Phase 0 follow-up is not another broad feature phase. It is a live-task benchmark that measures actual end-to-end task completion against Claude Code, Codex, and Gemini CLI on the same repo fixtures.

## Scorecard Status

Initial baseline intent:

- implemented: help, doctor, permissions, dry-run status, evidence status
- partial: MCP registry status
- implemented: MCP v2 doctor status, checkpoint restore command surface, session resume command surface, file-state checkpoint restore smoke coverage, shell/test-run filesystem-diff restore, executor model-context artifact, web context policy/citation-capable tools, MCP resource/prompt/tool-search surfaces, runtime plugin activation, strict enterprise policy doctor, subagent team contract, context injection preview, structured JSONL event stream contract, richer run/session stats, read-only CI review evidence, draft-only Git delivery surfaces, public export dry-run safety, local read-only schedule registry
- implemented: interactive slash-command discovery across daily, inspection, recovery, integration, and session workflows
- not started: scheduled automation

## Phase 2 Command Inventory

| Workflow | Interactive commands | CLI parity | Current evidence | Next fix |
| --- | --- | --- | --- | --- |
| Daily health | `/doctor`, `/status`, `/permissions`, `/mode`, `/model`, `/project` | `babel doctor`, `babel permissions`, `babel run --help` | Help UX and interactive smoke | Improve human output for failed doctor scopes |
| Inspection | `/runs`, `/inspect`, `/stats`, `/tools`, `/policy`, `/memory` | `babel inspect`, `babel stats`, `babel evidence` | Help UX and interactive smoke | Link run bundle paths to next restore commands |
| Recovery | `/checkpoint`, `/restore`, `/session` | `babel checkpoint`, `babel session` | Help UX and interactive smoke | Phase 3 restore risk matrix |
| Integrations | `/mcp`, `/plugins`, `/plugin`, `/agents` | `babel mcp`, `babel plugins`, `babel agents` | Help UX and product benchmark | Phase 4/5 doctor depth |

## Phase 4 Integration Policy Notes

- MCP `resources/read`, `prompts/get`, and `tools/search` are labeled as untrusted external content.
- `babel mcp doctor --json` reports the external-content policy alongside transport, auth, timeout, and lazy schema policy.
- Remaining integration work should investigate HTTP MCP and OAuth only after the same policy labels, auth hints, and failure events are designed.

## Phase 5 Plugin Author Checklist

- Use a globally unique `id` and keep trust level at `metadata` or `read_only` unless a hook truly mutates local files.
- Keep tool, slash-command, prompt-skill, and MCP server names unique within the manifest; `babel plugins doctor --json` now warns on duplicate surface names.
- Make local-mutating hooks support dry-run shadow roots where possible.
- Keep enterprise policy bypass impossible: enabling a plugin should still pass plugin id and trust-level policy checks.

## Phase 6 Delegation Design Note

- Current `babel agents` runs are `spec_contract_harness` executions: they execute declared fixture operations, write evidence, enforce read-only reviewer rules, and merge disjoint scoped writes.
- Live LLM subagents remain disabled and must require an explicit future opt-in with an isolation and rollback design.
- Isolation model today: default scoped project copy, optional Git worktree for suitable repos, merge only from declared write scopes.
- Rollback model today: merge evidence records changed paths and ownership, while file-level checkpoint restore remains the recovery primitive for ordinary executor mutations.

## Phase 7 GitHub Delivery Map

| Surface | Side effects | Evidence | Remote gate |
| --- | --- | --- | --- |
| `babel ci review --json` | Read-only Git inspection plus evidence write | `runs/ci-review/*` with `delivery_policy` | No remote operations |
| `babel git diff-summary|commit-draft|pr-draft --json` | Read-only Git inspection plus evidence write | `runs/git-drafts/*` with `delivery_policy` | No remote operations |
| `babel git branch-create|commit-create --json` | Explicit local Git mutation | `runs/git-mutations/*` policy/command/head before-after | Local only |
| `babel git pr-create --json` | Planned by default | `runs/git-mutations/*` planned PR command | Requires `--allow-remote` |

## Phase 8 Policy Pack Proposal

All packs keep redaction enabled. Strict enterprise mode should fail until one managed policy source exists.

`local-only`:

```json
{
  "schema_version": 1,
  "policy_name": "local-only",
  "allowed_tools": ["directory_list", "file_read", "file_write", "shell_exec", "test_run"],
  "allowed_mcp_servers": [],
  "network_allowlist": [],
  "model_policy": { "allowed_backends": ["local"] },
  "plugin_policy": { "max_trust_level": "local_mutating" },
  "redaction": { "enabled": true },
  "telemetry": { "opt_in": false }
}
```

`team-standard`:

```json
{
  "schema_version": 1,
  "policy_name": "team-standard",
  "allowed_tools": ["directory_list", "file_read", "file_write", "shell_exec", "test_run", "web_fetch", "mcp_tool_search", "plugin_tool"],
  "allowed_mcp_servers": ["github"],
  "network_allowlist": ["api.github.com", "github.com", "raw.githubusercontent.com", "registry.npmjs.org"],
  "model_policy": { "allowed_backends": ["deepinfra", "openai", "anthropic"] },
  "plugin_policy": { "allowed_plugins": ["sample-readonly"], "max_trust_level": "read_only" },
  "redaction": { "enabled": true },
  "telemetry": { "opt_in": false }
}
```

`regulated`:

```json
{
  "schema_version": 1,
  "policy_name": "regulated",
  "allowed_tools": ["directory_list", "file_read", "test_run"],
  "allowed_mcp_servers": [],
  "network_allowlist": [],
  "model_policy": { "allowed_backends": ["approved-private-backend"], "require_explicit_opt_in": ["*"] },
  "plugin_policy": { "allowed_plugins": [], "max_trust_level": "metadata" },
  "redaction": { "enabled": true, "extra_patterns": ["CUSTOM-[0-9]+"] },
  "telemetry": { "opt_in": false }
}
```

Migration risks:

- Allowlist packs can block existing tools, MCP servers, plugins, and model backends until admins enumerate them.
- Telemetry remains disabled unless `telemetry.opt_in` is explicitly true; turning it on should be a deliberate admin action.
- Redaction disabled in any managed policy fails doctor; admins should add extra patterns instead of disabling redaction.
- Denials now include `policy_source` and `fix_hint` so admins can identify the active JSON source and the safe knob to change.

## Phase 9 UI Surface Decision Record

Decision: keep the next bridge as a read-only JSONL event contract, surfaced by `babel events schema --json`, before building TUI, VS Code, webview, or cloud experiences.

Accepted surface:

- `babel run --events-jsonl <path>` writes schema-versioned JSONL envelopes during a run.
- `babel events schema --json` prints the machine-readable contract, event types, payload keys, and read-only bridge policy.
- Consumers should render timelines, logs, result links, and errors from the contract instead of scraping terminal text.

Rejected for this phase:

- VS Code extension: too much packaging and approval UX before the contract is stable.
- Local webview: useful for evidence browsing, but would add asset/server surface before read-only semantics are documented.
- Cloud bridge: requires authentication, upload policy, retention, and remote mutation decisions.
- TUI rewrite: improves terminal UX but does not solve non-terminal contract stability.

Next slice:

- Add a read-only evidence timeline summary that can merge event stream rows with run bundle artifacts.
- Keep approval and mutation actions out of UI consumers until an explicit approval protocol exists.

## Phase 10 Release Readiness Report

Resolved risks:

- The public release validation wrapper and product benchmark are part of the CI gate suite.
- `npm --prefix .\babel-cli run test:public-release` provides a single release gate for dry-run, temp export, scrub, catalog, typecheck, resolver, smoke, manifest preview, routing, MCP adapter, and wrapper preview probes.
- The Phase 10 benchmark demonstrates the dry-run prints planned operations and reports no writes/deletes/copies/Git mutations.

Remaining public-doc gaps:

- Public README should be reviewed in the exported tree after a real export, not only in the private vault.
- Final public-only hardening still belongs in the public repository.
- Release tagging, public CI wiring, and support/versioning policy need maintainer decisions before an external announcement.

## Phase 3 Recovery Risk Matrix

| Mutation type | Checkpoint coverage | Residual risk | Next improvement |
| --- | --- | --- | --- |
| `file_write` existing file | Captures target content and post-write hash; restore refuses later user edits unless forced | Binary/large files may be metadata-only if capture is skipped | Add diff preview before forced restore |
| `file_write` new file | Captures prior missing state and removes created file on restore | Non-file replacement paths are refused | Improve human explanation for non-regular paths |
| `shell_exec` | Captures bounded pre-command project snapshot, computes modified/created/deleted restore set, excludes cache/dependency/secret paths | Coverage can be partial when snapshot limits overflow | Promote high-risk runs into isolated copy/worktree execution |
| `test_run` | Same bounded filesystem-diff restore as `shell_exec` | Test commands can mutate generated artifacts outside the bounded project root | Surface excluded/generated-path notes in run inspection |

## Refresh Rule

Future claims in the product gap plan should point to at least one of:

- a benchmark scenario id from a dated artifact
- an official vendor documentation URL
- a local regression test
- an explicit no-action decision
