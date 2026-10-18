# Babel Desktop

Babel Desktop is the Windows UI for the authoritative Babel CLI harness. It starts connected to the harness and displays real responses, tools, approvals, sessions and verification outcomes. It never supplies simulated conversations, model responses or tool activity.

## Install and configure

Use the versioned Windows Setup.exe from the release/download page, or extract the complete portable ZIP. The bundle includes pinned Node, Electron, CLI, dependencies and immutable prompt resources. See [Windows setup](docs/INSTALL-WINDOWS.md).

Open **Providers and models** and choose OpenRouter, DeepSeek, DeepInfra, OpenCode Go or local Ollama. Enter a key for a cloud provider; leave the field blank to keep a saved key. Enable models and choose the default. Ordinary Chat can start without a project or Docker. Select and trust the exact project when files or commands are needed, and prepare its execution sandbox. Provider defaults and model preferences persist in the private Desktop profile. Catalog discovery is separate from execution support and live qualification; Ollama inventory identifies installed models.

Private keys use Electron `safeStorage` OS protection in `desktop-credentials.json`; unavailable or insecure OS backends fail closed. Choose Add, Replace, or Remove for one provider and destination. Optional project storage remains plaintext and requires a trusted selected project with an untracked, Git-ignored `.env`. Keys are never returned to the renderer or included in chat history. The app-owned CLI receives only the selected provider credential from the chosen scope; ambient provider keys are cleared.

Legacy private `.env` keys remain usable until explicitly migrated. Migration copies one provider into OS-protected storage and retains the original plaintext `.env` unchanged for recovery. Once migrated, the protected entry (including a removal marker) is authoritative, and retrying migration cannot restore a removed or replaced key. Future or invalid protected-store schemas reject edits. The standalone Node launcher cannot unlock OS protection and rejects any profile containing protected entries or removal markers; run that profile in Desktop. App-owned execution requires the CLI native credential capability; update or rebuild older engines. See [credential integration](docs/INTEGRATION.md) for recovery details.

Send a task to run the real CLI with the `safe_repo` execution profile. Run tests and Git status request tasks through that same run/approval path. Stop cancels the CLI process; Allow and Deny answer its approvals. File viewing is read-only. Unknown telemetry stays unknown. A zero exit without a trustworthy terminal result is unverified.

Chat follows Babel's persisted session ID for follow-up messages. Plan and Deep start their corresponding CLI workflows. Keyboard: Ctrl/Cmd+Enter sends, Ctrl/Cmd+K searches, Ctrl/Cmd+Alt+N starts a session, Alt+1/2/3 selects mode, Escape closes dialogs or drawers.

Unsent composer text stays with its chat and selected project binding in the local Desktop profile. You can prepare the next draft after the active run is admitted; Send remains unavailable until that run settles. Switching chats restores the draft and reading position. Closing flushes pending draft writes; a save failure offers keeping the window open to copy the text. Existing saved data is preserved when a newer draft format is encountered. Storage supports 100 draft/reading-position entries per project binding and an 8 MiB file limit; submitted conversation history remains owned by the CLI.

## Develop and verify

Build the sibling CLI first with its supported Node runtime. Then:

```sh
npm ci
npm run build
npm start
npm test
npm run test:ui
```

`npm run preview` serves the renderer for layout inspection; a browser without the native bridge cannot execute tasks. Desktop execution requires Electron. Renderer doubles and packaged fixture tests explicitly identify their test basis; they do not establish real provider authentication.

The native boundary validates IPC senders, provider/model choices, project files, task arguments and approvals. The CLI runs without shell interpolation. `safe_repo` is Babel's execution profile, not an OS sandbox. Runtime identity and diagnostics show the engine actually used. CLI update checks and activation retain qualification and checksum gates; source and packaged updates have distinct paths.

## Build Windows distributions

Use a clean committed candidate, pinned Node 24.13.1 and Electron 44.5.1 archives:

```sh
npm run package:windows -- --node-archive=<official-node-archive> --electron-archive=<official-electron-archive>
npm run package:windows:setup -- --payload-zip=<portable-zip> --payload-sha256s=<SHA256SUMS> --nsis-archive=<official-nsis-3.11.zip>
```

The builder verifies archive digests, packs the CLI and explicit Desktop allowlist, and emits BUILD.json, manifest and SHA256SUMS. Setup installs per user, creates Start Menu/uninstall entries, and stages upgrades with rollback. CI exercises the installer lifecycle. Packages remain unsigned until a signing process is supplied; do not claim publisher verification from checksums. Automatic Desktop self-updates are not implemented; install a newer verified Setup.exe.
