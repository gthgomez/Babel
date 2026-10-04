# Babel North Star implementation

## Approved basis
Implement the supplied BabelTuiNorthStar.png, not a redesign. The accompanying mission requires one authoritative Babel engine, Windows-first native hosting, and replaceable reference data.

## Implementation sequence
1. Pin behavior in dependency-free unit and browser tests: safe rendering, bounded event decoding, coherent modes, session switching, multiline composer, keyboard focus, and honest terminal states.
2. Reconstruct the 1536 x 1024 shell: 72 px header; 268 px left pane; flexible center; 332 px right pane; 42 px footer. Preserve all reference sections, card layout, and branding. Extract only the existing logo from the supplied image.
3. Add working preview interactions and replaceable data transport. Preview history is local-only and labeled. Never imply a model or tool actually ran.
4. Add an isolated Electron host and a Node child-process adapter for Babel's existing `run --output-format stream-json` entry point. No API keys, daemon, second runtime, or session database.
5. Exercise parser, native adapter against a local fixture subprocess, and UI in Chromium at reference and laptop viewports. Produce an offline, self-contained HTML preview and a source archive.

## Important integration boundaries found in current source
- `babel run --mode chat --project-root --output-format stream-json --execution-profile safe_repo` is the desktop child. It does not pass `--read-only` or `--yes`.
- The chat path forwards answer chunks, thoughts, tool rows, file changes, and cancellation onto stream-json. Plan and deep still use the pipeline event stream. Do not invent events the CLI did not emit.
- `--resume-chat <id>` restores a persisted Babel chat transcript for a later chat turn. `--session-id` remains the Local Mode evidence flag.
- With `BABEL_DESKTOP_IPC=1`, one stdin JSON line carries `allow_once`, `deny`, or `cancel`. Cancel calls the chat engine cancel, and the desktop process-tree kill is the backstop.
- Chat, Plan and Deep exist, but `run --mode plan` is not claimed equivalent to the interactive plan/approve/apply UI.

## Review focus
1. Untrusted text must never become executable markup.
2. Chunk boundaries and malformed/oversized output must not crash or hang the UI.
3. Switching sessions must not route an in-flight response into another session.
4. A zero process exit alone must not imply successful, verified completion.
5. UI-only tool switches must not become counterfeit native permission controls.

## Scope of this delivered increment
The Electron host launches the official sibling CLI. A connected project can send a chat, plan, or deep task. The center pane shows the user message, the streaming Babel reply, tool rows, and status. Changed paths from `file.changed` and `changed_files` appear under the project tree. Allow and Deny answer approval requests. Stop sends a cancel line and then ends the process tree if the CLI is still running. Saved transcripts under the repo `runs/chat-sessions` directory can be opened, and the next chat message resumes that Babel session. Installer, signing, and auto-update are still later work.
