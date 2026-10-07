# Babel integration evidence and next increment

## Inspected repository surface

Source: `gthgomez/Babel`, default branch, read through the connected GitHub API during this task. These are content blob hashes, not a single pinned checkout commit. No full repository clone or whole-repository test run was performed.

| Source | Blob | Relevant contract |
|---|---|---|
| `babel-cli/src/commands/workflowCommands.ts` | `3db61aedd1890cb3e6f07d2747068add1fb5783f` | `run` flags; JSONL output; Chat text-delta forwarding; one-shot execution |
| `babel-cli/src/cli/structuredOutput.ts` | `0d31d6644e373619eb470bb536ae639e7026f631` | `RunStreamEvent` and structured terminal payloads |
| `babel-cli/src/cli/userFacingStatus.ts` | `b7cf206a123f69123cdaa0852036a736b7f6112e` | Actual terminal outcome names and honest status mapping |
| `babel-cli/src/schemas/agentContracts.ts` | `842f4c1c28f4ac2880b0f66a595fb0a99c12df19` | Live mode names: chat, chat-headless, plan, deep |

Also inspected: root `AGENTS.md`, root and CLI `PROJECT_CONTEXT.md`, `src/index.ts`, command registration, and portions of `interactive/execution/chatCore.ts`.

## Decision

**The existing CLI can drive a first native one-shot slice, but not every North Star feature through the inspected output path.** This increment adds a frontend and adapter, not a replacement core.

Electron was selected for this source increment because the existing execution environment is Node/TypeScript, the adapter needs Node child-process streams, and a sandboxed HTML renderer reproduces the screenshot without a Rust sidecar or new service. Tauri remains a reasonable later packaging alternative but would add a second toolchain and Node sidecar handling here. No measured cross-framework startup, memory, or binary-size claim is made.

```text
North Star DOM interface
        │ fixed context-isolated IPC
Electron main process / one child controller
        │ existing CLI arguments + JSONL stdout
Existing trusted Babel CLI
        │
Existing providers, policies, orchestration, tools, evidence
```

## Current mappings

- Chat/Plan/Deep → validated `run --mode`; no independent desktop mode semantics.
- Composer → one task argument; no shell interpolation, `--yes`, or expensive-model override.
- Assistant text → existing `assistant_chunk`; final result → `run_complete`.
- Pipeline commands → `command.started` / `command.completed` when emitted.
- Chat tool, thought, file-change, and cancel events are forwarded on stream-json when the CLI emits them. Events that Babel does not emit stay absent.
- Status → known terminal outcomes; unknown completion remains unverified. Nonzero exit or malformed/missing stream prevents a verified report.
- Mode/model/tool sidebar → live mode uses selected mode and existing Babel default routing, not the screenshot's placeholder model names.
- Context meter → unknown until Babel supplies per-context values; cumulative token cost is not substituted for current context occupancy.
- File tree → bounded native read-only viewer, not an IDE or a second tool-execution engine.
- Sessions → the desktop reads Babel's `runs/chat-sessions` transcripts and resumes a chat with `--resume-chat`. It does not keep a second session database.
- Review/result cards → fixture cards for the reference; live structured result is available in the existing central evidence area without brittle arbitrary-prose parsing.

## Security boundary

Renderer: sandbox enabled, Node integration disabled, context isolation enabled, hash-based script CSP, no remote resources. IPC admits only the app's main frame and fixed packaged origin. The preload exposes a fixed method list, never generic IPC/shell access. External navigation is blocked; only a fixed repository link can be opened through native shell.

Native: user-selected trusted CLI, per-run confirmation, one child, no shell, no automatic approvals. Stderr is bounded and not sent to the renderer because it may contain sensitive provider diagnostics. Common credential paths and binary files are excluded from the viewer; all contents shown are escaped. The viewer is not a DLP scanner and cannot prove an ordinary source file contains no secrets. Folder results are limited to 300 entries; file contents to 256 KiB; JSONL lines to 1 MiB; stdout display to 24 MiB.

These controls do not establish that an arbitrary selected executable is safe. The CLI retains the user's existing permissions. `safe_repo` is Babel's guarded profile, not an OS sandbox.

## Required before a production Desktop claim

1. Run this source package on the target Windows machine against a trusted, built Babel checkout. Verify a real prompt, text stream, tool rows, a file change, an approval, a cancel, and every native picker.
2. Chat stream-json now forwards the tool, file, thought, and cancel events the engine already emits.
3. Chat follow-ups use `--resume-chat` against Babel's transcript. `--session-id` is still only the Local Mode evidence flag.
4. `BABEL_DESKTOP_IPC=1` carries allow, deny, and cancel on stdin. Cancel calls the chat engine, then the desktop ends the process tree if the CLI is still alive. There is no `--yes` bypass.
5. Surface actual provider/model availability and context occupancy. Review and verification receipts should use existing result/event contracts.
6. Installer packaging is implemented (NSIS 3.11 per-user Setup.exe wrapping the checksum-verified portable ZIP) and its lifecycle (install, launch/relaunch, upgrade, rollback, uninstall, reinstall) is qualified in CI by babel-desktop/test/installer-lifecycle/run-lifecycle.ps1. Remaining before a production distribution claim: code signing and update verification.

## Self-review

Corrected during implementation: a renderer bundle syntax defect; UTF-8 chunk handling; unbounded JSONL line behavior; task-as-option injection risk; traversal/symlink viewing; a made-up success token (now rejected); abnormal exit overriding a success event; incomplete event stream truthfulness; failed project activation leaving half-switched UI; and run admission reservation before asynchronous checks.

Validation uses actual local tests and explicit test doubles, not a live Babel model run. No fresh-context independent reviewer was available; this was a same-session self-review. Native Electron behavior remains unverified until target-device testing.

No upstream branch, PR, merge, or package publication was performed.
