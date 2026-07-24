# Babel Lite

<!--
status: STALE
last_verified: 2026-07-03
-->
> **2026-06-10:** User-facing CLI consolidated to `babel "<task>"`, `babel plan`, `babel deep`, `babel undo`. Removed `bl`/`lite`/`ask`/`do`/`fix` verbs exit with hints. Canonical contract: [LITE_COMMAND_CONTRACT.md](../LITE_COMMAND_CONTRACT.md).
>
> **2026-06-12:** TUI-hybrid Slices 2–3 shipped bounded verify→repair (`smallFix.ts`), live tool stream, REPL chat streaming, and run HUD prelude.

Babel Lite is the underlying single-agent session model for Babel's companion workflow. The user-facing CLI teaches `babel "<task>"`, `babel plan`, and `babel deep` on top of that session model.

Canonical contract: [docs/LITE_COMMAND_CONTRACT.md](../LITE_COMMAND_CONTRACT.md)

It is not a replacement for general-purpose coding agents, not a provider-agnostic autonomous executor, and not proof of mutating live subagents. The current product target is a direct daily CLI: Lite is the front door, and intent decides the lane. Complex read-only planning can stay in Lite with read-only Spark critique; clear implementation work can route to fix or governed Full when risk warrants it. Full should become orchestration over isolated Lite sessions, not a separate mutating engine.

## Active First-Use Path

```text
babel "<task>" | babel plan | babel deep
-> babel-cli/bin/babel.js
-> babel-cli/dist/index.js
-> babel-cli/src/index.ts
-> rewriteArgv() (bare task -> hidden daily)
-> deprecation shim for removed surfaces
-> babel-cli/src/commands/workflowCommands.ts
-> AgentSession
```

## Target Command Surface

```text
babel "<task>"  daily routing by intent (hidden daily router)
babel plan      plan -> review agent (warn) -> approve -> apply
babel deep      governed heavy path (deep_lane)
babel undo      restore last checkpoint
babel continue  resume worker chain / recovery
babel resume    continue retryable run
removed shims   bl / lite / ask / do / fix / full / propose / patch / review (exit 1 + hint)
```

Docs should teach `babel "<task>"`, `babel plan`, `babel deep`, and `babel undo` before advanced `babel run` forms. Removed `bl` / `lite` / `ask` / `do` / `fix` verbs exit with stderr hints — do not teach them as primary paths.

Babel Full orchestration contract: [docs/architecture/BABEL_FULL_ORCHESTRATION.md](./BABEL_FULL_ORCHESTRATION.md)

## Provider-Contract Lite Status

The older provider-contract Lite implementation still exists in:

```text
babel-cli/src/commands/liteCommands.ts
babel-cli/src/lite/
babel-cli/src/liteCli.ts
```

That path includes useful provider-backed ask/patch behavior and proposal-only patch artifacts. It should be treated as behavior to reconcile into the active workflow Lite path or rename as an internal text-provider lane, not as the canonical first-use contract.

## AgentSession

`runLiteCommand` dispatches through `AgentSession` in `babel-cli/src/agent/session.ts`. The verify-to-repair loop was shipped in **TUI-Hybrid Slice 2** (integrated via `smallFix.ts` timeline, utilizing bounded verify-repair cycles for mutations). The action loop flow is:

```text
repo context
-> model adapter
-> normalized action parser
-> permission policy
-> sandbox/tool executor
-> observation
-> checkpoint/verifier/repair loop (Slice 2) / recovery gate
```

The provider supplies reasoning; Babel owns authority over file access, command execution, network use, checkpoints, verification, and final status. User-facing product docs should describe permission presets (`babel permissions`) rather than internal pipeline modes (`direct`, `manual`, `verified`, `autonomous`). Default help hides pipeline mode flags; use `babel advanced` then `babel run --help` when you need them.

## Artifact Direction

The target artifact layout is documented in [docs/LITE_COMMAND_CONTRACT.md](../LITE_COMMAND_CONTRACT.md). The important product rule is simpler than the exact file list:

- read-only commands must not edit source files
- proposal commands must not apply patches
- fix commands must expose changed files, verification, checkpoint, evidence, usage, and next command

## Permission Presets

User-facing permission presets map to existing execution and approval profiles. Prefer these names over internal pipeline modes in daily docs.

| Preset | User intent | Execution profile | Approval profile | Daily mapping |
| --- | --- | --- | --- | --- |
| `--read-only` | Inspect and explain without edits | `read_only_audit` | `suggest` (dry-run) | `babel "<task>"` read-only routes, `babel plan` |
| default | Safe workspace work with checkpoint on fix | `safe_repo` | `auto-edit` | `babel "<task>"` fix routes |
| `--ask` | Prompt before each mutating action | `safe_repo` | `suggest` / ask-before-mutation policy | override on any lane |
| `--auto` | Trusted auto-edit inside workspace bounds | `safe_repo` | `full-auto` | power-user fix/deep only |

Internal pipeline modes (`direct`→`chat`, `verified`→`deep`, `manual`→`plan`, `autonomous`→`deep`, `parallel_swarm`→`deep` with swarm) remain available on `babel run` under `babel advanced`. They are intentionally hidden from default `--help`.

## Routing Role

Use Babel Lite as a companion entrypoint:

- `babel "<task>"` for the default daily path
- `babel plan` for approval-first planning and apply
- `babel deep` for explicit critique/refine/governed work
- `babel undo` for checkpoint recovery after a fix mutation
- removed compatibility shims (`bl`, `lite`, `ask`, `do`, `fix`, …) exit with canonical replacement hints
- full `babel run` for advanced pipeline controls, audit/event output, or explicit governed modes

Lite can auto-route implementation work to Babel Full when risk warrants it, but it must not do so silently. Complexity alone must not turn an audit, comparison, recommendation, diagnostic, or no-write plan into mutation-capable work.

## Full/Governance Triggers

These signals increase risk, but they do not override read-only intent by themselves:

- repo-wide / architecture / refactor / migration scope
- protected Babel control-plane files
- plugin, MCP, or public-export/gov surfaces
- repeated failures, recovery loops, rollback risk, or schema failure drift
- performance or security-sensitive phrasing

Escalate to Full/governed execution when the user explicitly asks for Full/governed/agented behavior, or when a clear implementation request carries those risk signals. Keep read-only audits, comparisons, diagnostics, recommendations, and no-write plans in read-only/report/plan lanes.

When escalated, CLI output (human and JSON) must show:

- `selected_lane`
- `route_reason`
- `complexity`
- `risk_signals`
- `model_tier_recommendation`
- `full_babel_equivalent`

Mutating live subagents remain disabled in this proof batch. Any future Full mutation claim requires isolated Lite-session evidence, conflict-resolution evidence, per-worker verifier artifacts, and rollback proof.

## Fresh-Clone Proof Commands

From a fresh checkout (PowerShell):

```powershell
npm --prefix .\babel-cli run build
npm --prefix .\babel-cli run test -- --test-path-pattern="agent|workflowCommands|argv|liteUsability|checkpoints|ciReview"
node .\babel-cli\dist\index.js benchmark lite --json
node .\babel-cli\dist\index.js benchmark production --json
npm run test:public-release
```

`benchmark lite` must report `8/8` pass covering ask, plan, patch, fix, do, propose, review, and undo routing scenarios (the broader `test:lite-gate` is at 269/269 as of 2026-06-29). `babel plan` and proposal lanes use read-only paths (`planLane`, `proposalLane`) and do not require Manual Bridge.

Excluded claims: mutating live subagents, universal mandatory verifiers.
