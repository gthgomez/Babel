# Babel Desktop — North Star shell

Visual shell for `BabelTuiNorthStar.png`, plus an Electron host. The opening screen is still the reference preview. After you connect a project, a task runs the sibling Babel CLI and the center panel shows that run in the same layout: your message, Babel's streaming reply, tool rows, and status.

## Open it immediately

Open `dist/index.html` in a modern browser. The separate `Babel-Desktop.html` deliverable is the same file. There is no build step, CDN, remote font, server, API key, or model call for the preview.

The initial reference session reproduces the supplied screenshot. The bottom bar and status panel explicitly label it **REFERENCE PREVIEW**. The screenshot's model names, file names, findings, tool results, and context numbers are reference fixtures, not facts about an actual current Babel run.

### Working interactions

- Chat / Plan / Deep selection is synchronized between the header and right sidebar. The model selector, tool-state previews, session list, new session, and more/less controls work.
- Project folders expand; files open in a read-only dialog. Preview files explicitly explain that their contents are not included. Search finds visible session titles and loaded file names.
- The composer supports multiline input, Ctrl+Enter / Cmd+Enter, and a cancellable **simulated** response. Preview history uses browser local storage where available. It is never passed off as native Babel session persistence.
- Tool rows expand to evidence details. Settings, error demonstration, copy, reduced motion, responsive drawers, focus states, and keyboard navigation are implemented.

Keyboard: Ctrl/Cmd+K searches; Ctrl/Cmd+Alt+N starts a session; Alt+1/2/3 switches mode; Escape closes dialogs/drawers.

Browser file-origin storage behavior differs between browsers. To use a stable local origin instead:

```sh
npm run build
npm run preview
```

The preview server prints its localhost address. These two commands use Node's built-ins and do not require `npm install`.

## Run the native source package

Prerequisite: Node.js 22 or newer and an internet connection for dependency installation.

```sh
npm install
npm run build
npm start
```

The package pins Electron 44.5.1. `npm install` writes `package-lock.json` for this package.

On startup the host resolves the official runtime at `../babel-cli/dist/index.js`. Build Babel with its own instructions first. If that file is missing, the connection dialog says the CLI is not built. Choosing a different entry is an advanced setting, not the normal startup path. The desktop never requests or stores an API key.

The reference preview stays the opening screen. After you open a project and choose Use Babel CLI, a task runs `babel run` in the selected mode. The answer streams into the Babel bubble, and tool rows use the same read / search / run / edit layout as the reference. Files Babel reports as changed are listed above the project tree. Saved Babel chats from this checkout appear in the session list and can be opened. Allow and Deny answer Babel's approval requests. Stop asks the CLI to cancel, then ends the process if it is still running.

Each live message launches the existing CLI as a child process:

```text
node <trusted-entry> run --mode <chat|plan|deep>
  --project-root <selected-project>
  --output-format stream-json
  --execution-profile safe_repo
  [--resume-chat <id>] -- <task>
```

In Electron, its executable is used with `ELECTRON_RUN_AS_NODE=1` instead of searching PATH for another Node installation. The task is a single argument after `--`; no shell is used. There is a native confirmation before each run. Chat follow-ups pass `--resume-chat` with the session id Babel reported for that desktop session. Plan and deep do not resume that chat. A new desktop session starts a new Babel chat.

**File changes follow Babel's `safe_repo` profile, not an operating-system sandbox.** A selected CLI is executable code. Run only your trusted build. Babel's existing provider, permission, and execution behavior remains authoritative.

### Native boundary in this increment

The native source contains isolated IPC, folder/CLI selection, a bounded read-only file viewer, a UTF-8-safe JSONL parser, a single-child controller, and renderer event mapping. Fixtures disappear when live mode is enabled. Unknown model/tool/context telemetry remains unknown.

The desktop does not keep a second session database. Chat continuity is Babel's own transcript: the id comes back on the run result, and the next chat message in that desktop session resumes it. Restarting the app does not list older CLI sessions. `--session-id` remains the Local Mode evidence flag and is not used for this resume.

Chat runs forward answer text, thoughts, tool rows, file-change rows, and approval requests that Babel emits. Plan and deep runs show pipeline stage lines in the same tool-row layout. Missing events are not invented. Reference findings and solution cards stay on the sample session. A failed, blocked, or unverified run can expand the structured CLI result.

Allow and Deny answer an approval in this window. Stop ends the run by stopping the CLI process tree. Closing the window does the same. Model-list discovery, a production installer, signing, and auto-update are not in this build.

## Validation

```sh
npm test
# Optional browser-test dependencies:
python -m pip install playwright
python -m playwright install chromium
npm run test:ui
```

`CHROMIUM_EXECUTABLE` can point to a locally installed Chromium. Browser tests use the exact bundled HTML through `set_content` because the build environment prohibited browser navigation. Preview serialization is tested with an explicit storage double. The native renderer tests use an explicit API double. The process-controller test launches `test/fixture-cli.mjs`, **not a real Babel model run**.

`npm run test:ui` writes screenshots and result JSON under `babel-desktop/artifacts/`. That directory is generated output and is not source. The harness captures 1536 × 1024, 1366 × 768, and 390 × 844. It does not assert pixel equality with the reference image.

Electron install, the native window, and a provider-backed Babel run are checked on a machine with the CLI built. Windows packaging is later work.

## Source map

```text
src/              Interface, design tokens, reference fixtures, event-to-view mapping
native/           Electron host, fixed preload API, CLI child, JSONL decoder, file viewer
scripts/          Dependency-free single-file build and optional preview server
test/             Pure unit tests, local CLI fixture, Chromium acceptance tests
docs/             Implementation scope, visual deviations, repository integration notes
assets/           Logo extracted from the supplied reference; no font files
references/       Original user-supplied North Star screenshot
artifacts/        Rendered screenshots and test evidence
```

This package is separate from the upstream Babel repository. It does not alter Babel's runtime or publish a branch or PR.
