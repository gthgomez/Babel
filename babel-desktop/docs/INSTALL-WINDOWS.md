# Babel Desktop — Windows installation

The installer and portable package include Babel Desktop, the authoritative Babel CLI, prompt assets, production dependencies, and Node 24.13.1. They require Windows x64. You do not need Node, npm, a source checkout, or a separate CLI build to launch them.

## Install with Setup.exe (per-user, unsigned package)

The release workflow now builds and attaches the Setup.exe alongside the portable ZIP, so a published release carries both. It performs the same per-user install without manual extraction: Start Menu shortcut, upgrade with rollback, and an entry under Settings -> Apps -> Installed apps -> Babel Desktop for uninstall. It installs only for the current Windows user, requires no administrator rights, and verifies the payload SHA256 before anything is written. Checksum verification confirms the payload bytes, not the publisher: this is still an **unsigned package** (SmartScreen will warn; see the signing note below). Silent install: run the Setup.exe with the /S switch from a command prompt.

1. Verify the Setup executable's SHA256 against its accompanying `.exe.sha256` file.
2. Run Setup and follow its per-user installation steps. For the portable ZIP instead, verify its SHA256 against SHA256SUMS, extract the **entire** ZIP to a writable directory, and keep its directory structure intact. Do not launch from inside the ZIP.
3. Open **Babel Desktop.exe**. First launch shows setup status. Choose your project with **Open project**.
4. Open **Providers and models**, choose DeepSeek, OpenRouter, DeepInfra, or OpenCode Go, and enter your API key in the masked input. By default Babel creates a private `.env` under the Desktop profile's `engine/config` directory, **not** in the project. Existing provider values are not overwritten. The optional **Selected project .env** choice is explicit and available only after selecting a Git repository where `.env` is untracked and Git-ignored. Project-local secrets can be read by project code and are not recommended. Do not paste credentials into chat, Git commits, screenshots or logs. Desktop does not import secrets from other apps. Existing process environment variables take precedence.
5. Install and start Docker Desktop separately with Linux containers for the default `safe_repo` execution profile. In **Setup**, choose **Prepare recommended image** to download and verify the pinned Linux amd64 Node 24 Bookworm image, including shell, Git, Node and npm. Preparation may take several minutes. Alternatively, expand **Use an existing local image**, enter an image reference, and choose **Validate and use image**. Validation runs an isolated shell/Git probe without project mounts or network access. The exact verified local image ID is saved for both Desktop and `Babel Harness.cmd`. Other languages or project tools require an appropriate custom image. Desktop does not start Docker, change Windows policy, or switch to unrestricted host execution.
6. Enable your models, choose a default, and save. The app connects to the harness automatically. Use **Recheck setup** if prerequisites need attention. Credential presence is not authentication; actual provider errors remain errors. A task may send project content to your configured provider and incur charges. Review Babel's normal run confirmation and tool approvals.

Credential-free Ollama routes do not require a cloud key. Start Ollama, choose Ollama in Providers and models, refresh its installed models, then enable and select a default.

For diagnostics without a provider call, open Command Prompt in the extracted folder and run:

```bat
"Babel Harness.cmd" --version
"Babel Harness.cmd" doctor --json
"Babel Harness.cmd" setup --json
```

`Babel CLI.cmd` remains available as a compatibility alias for earlier preview instructions.

By default Desktop stores UI preferences under `%APPDATA%\babel-north-star-desktop`, and CLI configuration/state/cache under its `engine` directory. Nothing is written back to bundled resources. Existing CLI profiles and saved sessions elsewhere are not imported. To use a separate profile, launch:

```bat
"Babel Desktop.exe" "--profile-dir=C:\Babel Profiles\Test One"
"Babel Harness.cmd" "--profile-dir=C:\Babel Profiles\Test One" doctor --json
```

Quit by closing the Desktop window. Closing requests cancellation before the application exits; active model-task shutdown is not qualified in this build. Restart from the same extracted directory with the same profile. Saved chats are read from Babel's own state directory.

## Credential security and project opt-in

- Babel stores a plaintext `.env` inside its **private user profile** by default, never inside the packaged executable or the selected repository. File permissions are restricted where the platform permits; this is **not** OS-keychain encryption. Keep device and profile access secure.
- Only explicitly selected, authority-qualified cloud provider credentials can be saved through Desktop. Existing provider entries are never overwritten automatically.
- A project-local `.env` requires explicit user selection, a selected real Git project root, and verification that the file is Git-ignored and untracked. An unsafe existing file, symlink, or non-ignored target is rejected without writing.
- A project-local file is not loaded merely because Babel opens a project. Only the explicitly opted-in project can supply recognized provider keys. Project application code may still read those bytes; use the private profile for safer defaults.
- Legacy developer `babel-cli/.env` loading requires explicit `BABEL_LEGACY_CLI_ENV=1` opt-in. Never commit either credential file.

## Runtime identity and updates

The right-hand **Runtime** panel shows the exact engine: Desktop version, CLI package version, CLI source commit and working-tree state, engine origin (bundled, development checkout, or advanced entry), the effective execution profile (`safe_repo`), provider/Docker/sandbox readiness, and the update status. A healthy Docker daemon alone is insufficient: the configured image must be available and run shell and Git. Setup rechecks this, and each packaged Desktop run checks again before a provider request. Update status reads **Not checked** until you press a check button; the panel never claims "up to date" without an actual check.

- **Source build (development checkout):** the panel offers **Check for CLI updates** and **Update development CLI**. The update inspects the checkout, refuses dirty, detached, diverged, or untrusted states, fetches `origin`, fast-forwards only (never a reset or a branch change), reinstalls locked dependencies, rebuilds the CLI with the repository's own commands, validates the rebuilt CLI version, and keeps the previous build for rollback. It requires your confirmation before running and never overwrites uncommitted work.
- **Packaged app:** the panel offers **Check for updates**, which queries the official release channel and compares it with the bundled version. The installed bundle is not modified. To update a packaged install, download the newer verified Setup.exe or ZIP and run it as above; automatic in-place updates are deliberately not implemented because a `git pull` inside installed resources would overwrite the app itself.

Checksum verification is not publisher authentication, and neither channel silently installs unsigned code.

The release workflow attaches versioned Setup.exe and portable ZIP assets with checksums and build metadata. Use the assets actually listed for your chosen release; older releases may provide only the portable ZIP.

This is an **unsigned application**. Windows SmartScreen may flag an unfamiliar unsigned application. No code-signing identity or SmartScreen reputation is provided. The portable ZIP has no Start Menu entry or uninstaller; the Setup.exe provides both, plus staged upgrade and rollback. Automated in-place Desktop updates are not implemented. Do not disable Windows security settings to run it. If your policy blocks unsigned software, retain the artifact for review and wait for a signed distribution.

To remove the portable application, quit it and delete its extracted directory. Profile data persists separately; remove it only if you intentionally want to erase settings and sessions. To update, extract a newer verified package into a separate directory, keep the same profile, and retain the old build for rollback. Cross-version profile migration is not qualified.

`BUILD.json` identifies the exact source commit and runtime versions. The accompanying qualification note distinguishes tests performed from unqualified behavior. Model inference and paid provider calls are not part of bundle qualification.
