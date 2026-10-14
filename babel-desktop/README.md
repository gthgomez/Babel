# Babel Desktop

Babel Desktop is the Windows UI for the authoritative Babel CLI harness. It starts connected to the harness and displays real responses, tools, approvals, sessions and verification outcomes. It never supplies simulated conversations, model responses or tool activity.

## Install and configure

Use the versioned Windows Setup.exe from the release/download page, or extract the complete portable ZIP. The bundle includes pinned Node, Electron, CLI, dependencies and immutable prompt resources. See [Windows setup](docs/INSTALL-WINDOWS.md).

Open a project, start Docker Desktop, then open **Providers and models**. Choose OpenRouter, DeepSeek, DeepInfra, OpenCode Go or local Ollama. Enter a key for a cloud provider; leave the field blank to keep a saved key. Enable models and choose the default. Provider defaults and model preferences persist in the private Desktop profile. Public catalog refresh exposes qualified CLI routes; Ollama refresh discovers models installed on this computer. Public availability alone does not qualify a model for the harness.

Keys are stored in a private plaintext `.env`, not an OS keychain. Optional project storage requires an explicitly selected, untracked, Git-ignored destination. Keys are never returned to the renderer or included in chat history. Existing process environment variables take precedence.

Send a task to run the real CLI with the `safe_repo` execution profile. Run tests and Git status request tasks through that same run/approval path. Stop cancels the CLI process; Allow and Deny answer its approvals. File viewing is read-only. Unknown telemetry stays unknown. A zero exit without a trustworthy terminal result is unverified.

Chat follows Babel's persisted session ID for follow-up messages. Plan and Deep start their corresponding CLI workflows. Keyboard: Ctrl/Cmd+Enter sends, Ctrl/Cmd+K searches, Ctrl/Cmd+Alt+N starts a session, Alt+1/2/3 selects mode, Escape closes dialogs or drawers.

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
