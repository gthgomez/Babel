<!--
status: ACTIVE
last_verified: 2026-08-22
-->
# Babel User-Shaped CLI Guide

Date: 2026-05-31

This guide captures the product direction for making Babel easier to use
without weakening internal routing, evidence, and safety contracts.

## North Star

Babel should feel like a usable work lane before it feels like a governance system.

The user-facing CLI should optimize for:
- short commands
- natural task text
- clear defaults
- visible progress
- approvals only when a real user decision is needed

The internals can still compile manifests, enforce contracts, record evidence, and apply policy. Those details should support the user path, not become the path.

## Secure Without Making Babel Unusable

Model-backed Babel usually needs to send selected context to a configured LLM provider. This is not a special failure state; it is how remote model-backed CLIs work.

User-facing security should:
- say what may be sent: task text, selected prompt layers, relevant file snippets, and verifier or log output
- show the provider/model and rough usage or cost when available
- ask only for meaningful boundary changes: unusual cost, enterprise-blocked model, dependency install, remote side effect, broad mutation, or unattended autonomy
- treat explicit CLI choices such as `--model deepseek`, `--model-tier standard`, or `--model-tier escalation` as user intent for that run
- treat the user's local workspace as the default trusted area for `--project-root`, `babel verify`, and workspace file inspection

Avoid making the user approve the same intent twice. If a user has configured credentials and chosen a model lane, Babel should help them work.

Teams that need a narrower local boundary can set `BABEL_OPENCLAW_APPROVED_ROOTS` to a semicolon-separated allowlist. That is an expert or enterprise control, not the default first-run path.

## Daily CLI Shape

Teach the short commands first:

```powershell
node .\babel-cli\dist\index.js "why is this failing?"
node .\babel-cli\dist\index.js plan "how should we split auth safely?"
node .\babel-cli\dist\index.js "what should we implement next?"
node .\babel-cli\dist\index.js deep "harden the parser fix before applying it"
```

The intended behavior is:
- `babel "<task>"` is the default path. It answers read-only requests directly and can inspect, edit, verify, and summarize when the task clearly asks for implementation.
- `babel plan` prepares an implementation plan, asks for approval, then applies and verifies in the same flow after approval.
- `babel deep` is the explicit critique/refine/governed path for higher-risk work.

Removed surface tokens (`lite`, `l`, `full`, `bl`, `babel-lite`, `daily`) **exit 1** with stderr hints. Other legacy daily verbs were never registered: `ask`, `do`, `fix`, `propose`, and `patch` fall through to the chat lane as ordinary task text, and `review` is rejected as an unknown command. Do not teach any of them. Canonical contract: [CLI_COMMAND_CONTRACT.md](./CLI_COMMAND_CONTRACT.md).

Fresh clone and first-run (source checkout; not an npm registry package):

`dev_local` executes approved tools directly on your host with no container isolation. Use it only for repositories you own and code you have reviewed. For untrusted repositories or unreviewed code, stay on the isolated `safe_repo` profile (the default).

```powershell
git clone <repo-url>
cd <repo-directory>
npm --prefix .\babel-cli ci
npm --prefix .\babel-cli run build
node .\babel-cli\dist\index.js doctor
$env:BABEL_EXECUTION_PROFILE = 'dev_local'
node .\babel-cli\dist\index.js "why is this failing?"
```

If `dist/index.js` is missing on a fresh checkout, rerun:

```powershell
npm --prefix .\babel-cli run build
```

`babel` on PATH only exists after you install/link the `babel-cli` package
binary yourself. These docs do not assume that. The taught source command is
`node .\babel-cli\dist\index.js`.

The bare task shortcut is the primary default:

```powershell
node .\babel-cli\dist\index.js "fix failing tests"
```

Treat `babel run` as the advanced pipeline lane, not the first command a user has to learn:

```powershell
babel run "fix the parser test" --mode deep
babel run "prepare a rollout plan" --mode plan --show-model-policy
```

Use it when the user explicitly needs pipeline modes, audit artifacts, JSON/event-stream output, manual bridge behavior, or detailed tool/model controls.

## Command Design Rules

- Prefer positional task text over required prompt flags.
- Use obvious commands: `babel "<task>"`, `babel plan`, `babel deep`; older Lite-era verbs were removed from the surface, not kept as compatibility.
- Teach command hierarchy in this order: `babel "<task>"`, then `babel plan`, then `babel deep`, then `babel run` for advanced pipeline control.
- Let provider and mode defaults work automatically when the environment is already configured.
- Show short progress and final outcomes by default.
- Distinguish provider-configured and providerless modes with one clear explanation each.
- Put audit paths, manifest IDs, provider traces, and contract detail behind `--verbose`, `--json`, or explicit diagnostic commands.
- Make approval prompts explain the action in user terms: what will be called, what may be changed, and what cost or network boundary is involved.
- Do not use policy language as the first explanation when a simpler user-facing explanation is enough.

## Docs Organization

Every user-facing CLI doc should lead in this order:

1. The shortest successful command.
2. What the command does in one sentence.
3. Common variants.
4. What happens when approval or credentials are needed.
5. Advanced flags, artifacts, and governance detail.

Avoid opening with architecture terms such as control plane, manifest, verifier, artifact, or resolution policy unless the page is specifically for Babel internals.

## Runtime Implementation Checklist

**Historical reference (pre-convergence).** This checklist describes the retired
babel-lite/pipeline-era surface and is kept for archaeology only. It does not
describe the shipped CLI: the `bl`, `babel-lite`, `babel lite`, and `babel l`
entry points now exit `1` with removal hints, and the verb-preservation bullets
below no longer apply. The current daily surface is `babel "<task>"`,
`babel plan`, `babel deep`, and `babel undo`/`resume`/`doctor`.

The pre-convergence mainline CLI routed dedicated Lite calls through `bl`, `babel-lite`, `babel lite`, and `babel l`, and exposed the same user verbs on the main `babel` entrypoint:

- Keep binary aliases in `babel-cli/package.json`: `bl` and `babel-lite`.
- Keep `babel-cli/bin/babel-lite.js` delegating to the compiled CLI entrypoint.
- Keep `babel lite` with alias `babel l` on the main `babel` command.
- Preserve positional task text for `ask`, `plan`, `do`, proposal-only `patch`, and `fix`.
- Keep the dedicated Lite output renderer so `plan` does not expose Manual Bridge internals.
- Keep CLI help centered on `babel`, `babel plan`, and `babel deep` before the longer `babel run` forms.
- Keep command-level tests beyond the argv alias layer.
- Keep fixture-based usability tests for `ask`, `plan`, `do`, proposal-only `patch`, and `fix` through `babel benchmark lite`.
- Keep root help focused on daily commands, with `babel advanced` and `babel internals` for deeper surfaces.
- Keep `babel run` discoverable as the advanced pipeline lane for explicit modes, audit paths, stream output, and detailed tool/model controls.
- Keep Lite result output carrying `usage` so token and cost comparisons are visible from `--json` and summarized in text output.
- Keep read-only questions on the direct answer path unless a future dedicated ask engine can answer with fewer model calls and equal evidence.
- Keep provider/API approvals user-shaped: normal configured remote model use should continue; escalation prompts should explain the boundary and offer the shortest next command.
- Add provider-backed smoke tests only where credentials and approval are available; skipped live tests must say exactly what was skipped.

## Usability Benchmark

Run the deterministic Lite-vs-full command-shape benchmark (the `lite` suite name is retained from the retired Lite era; it now compares daily default-path commands against full `babel run` shapes):

```powershell
npm --prefix .\babel-cli run build
node .\babel-cli\dist\index.js benchmark lite
```

The benchmark checks fixture scenarios for:
- the default path staying read-only for questions and action-capable for clear implementation tasks.
- `plan` staying approval-first with user-facing output.
- `deep` staying explicit and governed for higher-risk tasks.
- natural task text surviving routing so user intent is preserved end to end.
- output contracts that include status, usage, changed files or run evidence, and next steps.

## Acceptance Criteria

- A new user can understand the first Babel CLI command without reading Babel architecture docs.
- The shortest command is also the recommended command.
- Advanced governance remains inspectable but does not dominate the happy path.
- Approval and credential failures are actionable in one screen of output.
- Docs for Babel internals continue to preserve the Behavioral OS, Domain Architect, Skill, adapter, and overlay separation.
