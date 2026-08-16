# Babel — Getting Started Guide

<!--
status: SUPERSEDED
last_verified: 2026-07-03
-->
> **Archived (2026-08-15).** Historical onboarding guide. Its "Use `babel deep` for all
> implementation work" guidance is **retired**: chat (`babel "<task>"`) is the daily
> implementation lane; `babel deep` is the explicit governed path. Its `babel permissions
> <preset>` profile-switching example does not match the current permissions surface.
>
> Superseded by:
> - [CLI_QUICKSTART.md](../../CLI_QUICKSTART.md)
> - [CHAT_MODE.md](../../CHAT_MODE.md)
> - [CLI_COMMAND_CONTRACT.md](../../CLI_COMMAND_CONTRACT.md)

Babel is a governance-first daily coding CLI. This guide walks you from
install to your first governed execution in under 10 minutes.

## 1. Install and build

```powershell
# Clone the repo
git clone <your-babel-repo-url>
cd babel-cli

# Install dependencies and build
npm ci
npm run build
```

Verify the build succeeded:

```powershell
node dist\index.js --help
```

You should see: `babel "<task>"` — the default daily command.

## 2. Check workspace health

```powershell
babel doctor
```

This checks Node.js, git, environment variables, and workspace setup.
Fix any issues it reports before continuing.

For a strict enterprise check:

```powershell
babel doctor --scope all --strict
```

## 3. Your first task — read-only exploration

Babel treats read-only questions as safe by default. Start simple:

```powershell
babel "explain the architecture of this repo"
```

Babel will read files, analyze structure, and produce an evidence-backed
answer. It will not modify anything.

## 4. Plan before you act

Before changing code, create a plan:

```powershell
babel plan "add a --verbose flag to the doctor command"
```

This produces a structured plan with:
- A minimal action set (exactly which files to change)
- Contract impact classification (COMPATIBLE / RISKY / BREAKING)
- Verification strategy

Review the plan. If it looks wrong, iterate with more context. Babel does
not execute the plan — you decide when to proceed.

## 5. Governed execution — babel deep

For implementation work, use the governed path:

```powershell
babel deep "implement the --verbose flag for doctor"
```

`babel deep` follows this pipeline:
1. **Orchestrator** — routes the task, selects domain and model
2. **SWE Agent** — produces a minimal action plan
3. **QA Reviewer** — adversarially audits the plan (up to 3 revision cycles)
4. **CLI Executor** — executes the approved plan with JIT approval

At each step, Babel writes evidence to `runs/`. You can inspect any run:

```powershell
babel inspect run runs/<run-dir>
```

## 6. Recovery — undo and resume

Made a mistake? Undo the last run:

```powershell
babel undo
```

Babel keeps per-tool-call checkpoints. `babel undo` restores files to
their pre-mutation state.

If a run was interrupted, resume it:

```powershell
babel resume
```

## 7. Understand your permissions

Babel ships with four permission profiles:

| Profile | Behavior |
|---------|----------|
| `read_only` | No file writes or shell execution |
| `ask_before_mutation` | Asks before any mutation |
| `workspace_write` | Allows writes within the workspace |
| `auto_safe` | Allows safe commands, asks for risky ones |

Check your current profile:

```powershell
babel permissions
```

Switch profiles:

```powershell
babel permissions ask_before_mutation
```

## 8. Dry-run mode

Test what Babel would do without actually changing anything:

```powershell
babel dry on
babel "fix the type error in src/helpers.ts"
babel dry off
```

In dry-run mode, file writes are intercepted and logged instead of applied.

## 9. Inspect evidence

Every Babel run produces an evidence bundle. Inspect it:

```powershell
babel inspect run <run-dir>
babel inspect summary <run-dir>
babel stats run <run-dir>
```

Evidence bundles contain the plan, QA verdicts, tool call log, and
telemetry — everything needed to audit what happened.

## 10. Next steps

- **Use `babel deep` for all implementation work** — the governed path
  catches mistakes before they reach production.
- **Read `docs/architecture/ARCHITECTURE.md`** for the full system design.
- **Run `babel benchmark product --json`** to see your Babel install's
  capability scorecard.
- **Enable adversarial QA** for extra safety:
  ```powershell
  $env:BABEL_ADVERSARIAL_REVIEW = 'true'
  babel deep "critical security patch"
  ```
- **Explore skills**: `babel skill doctor` shows available skills.
- **Understand Babel's positioning**: Babel is a governance-first coding
  CLI, not a general-purpose agent.

---

*Babel — governance-first, user-shaped, evidence-backed.*
