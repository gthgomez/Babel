# Babel Desktop - North Star shell

## Windows portable preview

The Windows x64 portable bundle includes the Desktop shell, official CLI, immutable prompt assets, production dependencies, and pinned Node 24.13.1. A consumer needs neither npm nor a source checkout. See [installation and setup](docs/INSTALL-WINDOWS.md).

For contributors, use the combined Desktop and installed-CLI candidate, install both package lockfiles, and run these commands with the pinned Node runtime on PATH:

```sh
npm ci
npm --prefix ../babel-cli ci --ignore-scripts
npm run package:windows -- --node-archive=<absolute-official-node-v24.13.1-win-x64.zip> --electron-archive=<absolute-official-electron-v44.5.1-win32-x64.zip>

The optional Setup.exe builder wraps the verified portable ZIP in a pinned NSIS 3.11 package (per-user install: Start Menu shortcut, staged upgrade/rollback, HKCU uninstall registration). The installer lifecycle (install, upgrade, rollback, uninstall, reinstall) is qualified by babel-desktop/test/installer-lifecycle/run-lifecycle.ps1, enforced in CI by the installer-lifecycle job. Still unsigned; still preview:
npm run package:windows:setup -- --payload-zip=<portable-zip> --payload-sha256s=<SHA256SUMS> --nsis-archive=<official-nsis-3.11.zip>
```

The builder checks pinned Node and Electron archive SHA256 values, freshly extracts Electron instead of trusting an existing dependency folder, requires a committed source candidate, builds and packs the canonical CLI, installs only lockfile-resolved production dependencies without lifecycle scripts, and copies an explicit Desktop allowlist. It produces the portable ZIP, file manifest, BUILD.json, and SHA256SUMS under `artifacts/windows/`. It refuses to overwrite prior outputs. The bundle is unsigned and code signing is not provided; the per-user Setup.exe builder (install, staged upgrade/rollback, uninstall) is already qualified by CI and is now built and attached by the release workflow. Automatic in-place updates are not implemented: a source build refreshes its own CLI from the Runtime panel, and a packaged install is updated by running a newer verified Setup.exe.

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

In a source build the host resolves the official runtime at `../babel-cli/dist/index.js`. Build Babel with its own instructions first. If that file is missing, the connection dialog says the CLI is not built. Choosing a different entry is an advanced source setting. A packaged app uses only its bundled CLI and Node. Desktop now has a masked **Configure provider** dialog. By default it writes credentials into the private profile `engine/config/.env` outside selected projects. The optional project-local `.env` destination is explicit, requires a Git-ignored untracked target, and may expose the key to project code. No secret is stored in renderer preferences or app-provided chat history. This is plaintext .env storage, not OS-keychain encryption.

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

The desktop does not keep a second session database. Chat continuity is Babel's own transcript: the id comes back on the run result, and the next chat message in that desktop session resumes it. After reconnecting, saved chats come from the same `BABEL_RUNS_DIR` used by the child CLI; packaged builds place it under the Desktop profile. `--session-id` remains the Local Mode evidence flag and is not used for this resume.

Chat runs forward answer text, thoughts, tool rows, file-change rows, and approval requests that Babel emits. Plan and deep runs show pipeline stage lines in the same tool-row layout. Missing events are not invented. Reference findings and solution cards stay on the sample session. A failed, blocked, or unverified run can expand the structured CLI result.

Allow and Deny answer an approval in this window. Stop ends the run by stopping the CLI process tree. Closing the window does the same. Model-list discovery and code signing are not in this build.

The right-hand **Runtime** panel reports the exact engine the host will run: Desktop version, CLI package version, CLI source commit and dirty state, origin (bundled, development checkout, or advanced entry), the effective `safe_repo` profile, provider/Docker readiness, and the update status of an explicit check. A source build adds **Update development CLI**, which refuses dirty/detached/diverged/untrusted checkouts, fetches the trusted upstream, fast-forwards only, reinstalls locked dependencies, rebuilds with the repository's own commands, validates the result, and keeps the previous build for rollback.

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

Portable bundle qualification uses the actual Electron executable and bundled CLI in a clean temporary installation/profile. Model-backed execution remains a separate qualification requiring a configured provider and Docker.

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

The Desktop remains a shell over the canonical Babel CLI; it owns no alternate execution engine.
