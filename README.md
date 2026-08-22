# Babel

[![Release](https://img.shields.io/github/v/release/gthgomez/Babel?display_name=tag&sort=semver)](https://github.com/gthgomez/Babel/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/gthgomez/Babel/typecheck.yml?branch=main&label=Public%20Release%20Gate)](https://github.com/gthgomez/Babel/actions)

**Open-source agent harness for real software work.**

Babel is a local coding agent with a conversational **chat** loop, explicit
**plan** and **deep** modes, and an inspectable Prompt OS underneath. It gives a
model the context, tools, permissions, workflows, and evidence needed to work
inside a real repository—while keeping the operating instructions visible and
testable.

> Babel is pre-1.0. The public checkout is runnable and typechecked, but model
> choice, provider setup, sandboxing, and repository-specific execution policy
> still matter. See [using chat mode](./docs/CHAT_MODE.md) and
> [current vision](./docs/VISION.md) for the public product boundaries.

## See Babel in action

<!-- TODO(maintainer): capture a real current TUI screenshot or recording to docs/assets/tui-chat.png and embed it here. Do not fabricate imagery. -->

Illustrative transcript (not a live capture) of a chat turn in the Babel TUI:

```text
BABEL · READY · CHAT · MyProject · deepseek
──────────────────────────────────────────────────

You
  Fix the failing webhook retry test and make sure
  duplicate deliveries can't double-process payments.

Babel
  I'll inspect the webhook handler and its tests first.

  ▸ Read src/webhooks/stripe.ts
  ▸ Read tests/webhooks/stripe.test.ts
  ▸ Search idempotency handling

  Found it: retries re-run the handler without a delivery key...

  ▸ Edited src/webhooks/stripe.ts
  ▸ Edited tests/webhooks/stripe.test.ts
  ▸ npm test -- stripe

  ✓ 18 passed

  Completed · 2 files changed · verified
```

**Chat is the default.** Talk to Babel like another engineer in your terminal.
It can inspect your repository, use tools, edit files with permission, run
verification, remember the conversation across turns, and pick up where it left
off later.

### Three modes, one product

| Mode | What it feels like |
|---|---|
| **Chat** | Work normally. Ask questions, iterate, inspect files, make changes and verify them. |
| **Plan** | Have Babel investigate and propose the implementation first. You approve before anything changes. |
| **Deep** | The heavy-duty path for risky work. Babel plans, critiques its own plan, executes under stricter controls, and verifies the result. |

Under the hood, Deep uses Babel's governed execution pipeline—but you don't
need to know that to use it.

### Inside a session

Start the interactive TUI:

```powershell
node .\babel-cli\dist\index.js interactive
```

Then just talk to it:

```text
> Explain this codebase
> Fix the failing auth test
> Review the changes you just made
> Now simplify that implementation
```

Useful commands while you work:

```text
/model       switch models
/mode        chat / plan / deep
/diff        inspect the latest changes
/resume      continue an earlier conversation
/cost        inspect current usage
/permissions change approval behavior
/help        see everything
```

Or hand Babel a task directly:

```powershell
node .\babel-cli\dist\index.js "Fix the failing webhook retry test"
node .\babel-cli\dist\index.js plan "Split the auth module safely"
node .\babel-cli\dist\index.js deep "Harden the migration path and verify it"
```

Read [the complete chat-mode reference](./docs/CHAT_MODE.md) for routing,
sessions, permissions, and advanced configuration.

## Why Babel

Most coding agents expose a model and a tool loop. Babel also exposes the
harness around that loop:

| Harness surface | What it gives you |
|---|---|
| **Chat** | A lightweight, multi-turn daily coding loop with live tool use |
| **Plan** | A reviewable plan before changes are applied |
| **Deep** | Routed planning, adversarial review, execution, and verification for higher-risk work |
| **Prompt OS** | Modular behavioral rules, domain expertise, skills, model adapters, and overlays |
| **Control plane** | Catalog validation, stack/manifest previews, typed contracts, and read-only MCP inspection |
| **Evidence** | Checkpoints, run artifacts, cost tracking, diagnostics, and recovery tools such as `undo` |

The model supplies reasoning. The harness supplies the working context, tools,
state, permissions, workflow, and proof around that reasoning.

Chat is the default mode; headless chat serves scripts and CI:

```powershell
node .\babel-cli\dist\index.js chat --headless "Summarize the failing test"
```

Legacy mode names remain accepted as aliases, but new integrations should use
`chat`, `plan`, and `deep`.

## Quick start from source

Babel is currently easiest to run from a clone of this repository. It requires
Node.js 22.5+ (`babel-cli` `engines.node`) for the CLI build. There is no
published npm package for this CLI today; run it from a clone.

```powershell
git clone https://github.com/gthgomez/Babel.git
cd Babel
npm --prefix .\babel-cli ci
npm --prefix .\babel-cli run build
node .\babel-cli\dist\index.js doctor
```

Model-backed sessions need a configured provider. Credentials belong in your
environment or credential manager, never in the repository.

For local development, copy `babel-cli/.env.example` to `babel-cli/.env` and
set only the providers you use. Babel loads that one package-local file at the
CLI boundary; variables already supplied by the host or CI take precedence.
Provider code resolves credentials through the shared registry/credential hub
and never logs, hashes, or persists secret values.

## Inspect before you execute

You can validate Babel and preview the instruction stack without a model or API
key:

```powershell
pwsh -File .\tools\validate-public-release.ps1

pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory backend `
  -Project example_saas_backend `
  -Model codex `
  -PipelineMode deep `
  -Format json
```

Compare the result with the checked-in
[backend manifest preview](./examples/manifest-previews/backend-deep.json).
For integrations, `babel mcp` exposes the read-only control-plane surface.

This preview-first path is intentional: you can inspect what Babel would load
before asking a model to act.

## How the harness works

Before a model runs, Babel resolves an ordered stack from
[`prompt_catalog.yaml`](./prompt_catalog.yaml):

1. **Behavioral rules** — how the agent plans, acts, verifies, and stays safe.
2. **Domain architect** — the technical lens for backend, frontend, mobile, and other work.
3. **Skills** — reusable workflows for testing, review, governance, release, and more.
4. **Model adapter** — model-specific delivery shaping.
5. **Project and task overlays** — context for the target workspace and task.
6. **Manifest** — the exact ordered stack, available for preview and validation.

That makes the agent’s operating instructions modular, versioned, and
inspectable rather than one opaque prompt. The stack is an important part of
Babel, but it serves the agent harness—it is not a separate product users must
understand before they can start a coding session.

## What is in the repository

```text
Babel/
├── babel-cli/              # Local coding-agent runtime and TUI
├── 00_System_Router/       # Typed routing and runtime contracts
├── 01_Behavioral_OS/       # Shared execution behavior and evidence discipline
├── 02_Domain_Architects/   # Backend, frontend, mobile, and other technical lanes
├── 02_Skills/              # Reusable workflows
├── 03_Model_Adapters/      # Model-specific shaping
├── 05_Project_Overlays/    # Public project context examples
├── 06_Task_Overlays/       # Public task context examples
├── examples/               # Golden previews and first-success fixtures
├── docs/                   # Product, CLI, architecture, audit, and release docs
└── tools/                  # Validation, scrub, and release gates
```

## Product status and positioning

Babel is an open-source coding-agent CLI with a distinctive inspectable and
governed harness. It is pre-1.0 and describes its current public capabilities
directly rather than making parity claims about other coding agents.

The strongest public proof today is:

- a runnable local CLI with chat, plan, and deep routes;
- deterministic catalog and stack/manifest validation;
- typed routing and runtime contracts;
- read-only MCP inspection;
- public release, scrub, and secret-scan gates; and
- locally tested evidence, checkpoint, rollback, and diagnostics components.

Provider-backed runs still depend on local credentials and environment setup.
Claims about universal verifiers, unrestricted autonomous workers, mutating
subagent teams, sandbox parity, or market parity are intentionally excluded.

## Documentation

- [Start Here](./START_HERE.md) — start using Babel, then inspect how it works
- [CLI quickstart](./docs/CLI_QUICKSTART.md) — chat, plan, deep, doctor, and MCP
- [Using chat mode](./docs/CHAT_MODE.md) — the default daily runtime in depth
- [Vision](./docs/VISION.md) — product principles and public scope
- [Architecture](./docs/architecture/ARCHITECTURE.md) — system shape and layers
- [Harness architecture](./docs/architecture/HARNESS_ARCHITECTURE_V1.md) — normative runtime contract
- [Harness hardening roadmap](./docs/architecture/HARNESS_HARDENING_ROADMAP_V1.md) — canonical H0–H7 implementation sequence
- [Portable agent workflow plan](./docs/guides/PORTABLE_AGENT_WORKFLOW_PLAN.md) — proposed cross-harness contract, subordinate to the native harness
- [Integration guide](./INTEGRATION.md) — integration and model-facing invocation contract
- [Contributing](./CONTRIBUTING.md)

## Contributing

The highest-value contributions improve the agent as a product:

- make the daily chat loop more reliable and legible;
- improve plan, deep, verification, and recovery UX;
- add end-to-end coding-task examples;
- strengthen stack selection and conflict explanations; and
- keep public release and security gates reproducible.

Keep credentials, private paths, operator notes, and private dependency
fingerprints out of public docs and fixtures.

## License

Apache License 2.0. Use it, fork it, and build on it.

Historical tagged releases that shipped under MIT remain MIT for those
snapshots. This tree is Apache-2.0 going forward.

Full text: [LICENSE](./LICENSE)
