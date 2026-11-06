# Babel Desktop — Windows installation

> **Version note:** these steps describe current-source Windows builds. Check `BUILD.json` for the exact installed source. The older [0.1.3 release](https://github.com/gthgomez/Babel/releases/tag/v0.1.3) uses private plaintext credentials, cannot replace saved keys through its provider dialog, and asks before every run. See the [Desktop README](../README.md) for current capabilities.

The installer and portable package include Babel Desktop, the authoritative Babel CLI, prompt assets, production dependencies, and Node 24.13.1. They require Windows x64. You do not need Node, npm, a source checkout, or a separate CLI build to launch them.

## Install with Setup.exe (per-user, unsigned package)

The release workflow now builds and attaches the Setup.exe alongside the portable ZIP, so a published release carries both. It performs the same per-user install without manual extraction: Start Menu shortcut, upgrade with rollback, and an entry under Settings -> Apps -> Installed apps -> Babel Desktop for uninstall. It installs only for the current Windows user, requires no administrator rights, and verifies the payload SHA256 before anything is written. Checksum verification confirms the payload bytes, not the publisher: this is still an **unsigned package** (SmartScreen will warn; see the signing note below). Silent install: run the Setup.exe with the /S switch from a command prompt.

1. Verify the Setup executable's SHA256 against its accompanying `.exe.sha256` file.
2. Run Setup and follow its per-user installation steps. For the portable ZIP instead, verify its SHA256 against SHA256SUMS, extract the **entire** ZIP to a writable directory, and keep its directory structure intact. Do not launch from inside the ZIP.
3. Open **Babel Desktop.exe**. First launch shows setup status. Choose your project with **Open project**.
4. Open **Providers and models**, choose your provider, and enter its key in the masked input. Private keys use Windows-protected storage under the profile's `engine/config` directory. **Key action** selects **Add a new key** or **Replace the saved key** explicitly; a blank key retains the saved value. For a legacy private plaintext key, use **Migrate legacy key** and confirm retention of the original recovery file before replacing it. Project-local storage remains an explicit plaintext option requiring an ignored, untracked `.env` in the selected Git project. Desktop resolves only the selected provider's saved credential for its child; inherited provider keys do not override it. Never put keys in chat, screenshots, logs, or Git.
5. Install and start Docker Desktop separately with Linux containers for the default `safe_repo` execution profile. In **Setup**, choose **Prepare recommended image** to download and verify the pinned Linux amd64 Node 24 Bookworm image, including shell, Git, Node and npm. Preparation may take several minutes. Alternatively, expand **Use an existing local image**, enter an image reference, and choose **Validate and use image**. Validation runs an isolated shell/Git probe without project mounts or network access. The exact verified local image ID is saved for both Desktop and `Babel Harness.cmd`. Other languages or project tools require an appropriate custom image. Desktop does not start Docker, change Windows policy, or switch to unrestricted host execution.
6. Refresh available models, enable the ones you want, choose a default, and save. Catalog metadata does not prove account access or successful inference. A manual provider model ID is available where supported and remains marked unverified. Select **Trust project** before project execution; trust is remembered for that directory and repository identity and can be revoked in connection details. Submitted tasks then start without a per-run confirmation. Tool-specific approvals and sandbox protections still apply. Use **Recheck setup** for missing prerequisites. Tasks can send project content to the selected provider and incur charges; provider errors remain failures.

Credential-free Ollama routes do not require a cloud key. Start Ollama, choose Ollama in Providers and models, refresh its installed models, then enable and select a default.

For diagnostics without a provider call, open Command Prompt in the extracted folder and run:

```bat
"Babel Harness.cmd" --version
"Babel Harness.cmd" doctor --json
"Babel Harness.cmd" setup --json
```

`Babel CLI.cmd` remains available as a compatibility alias for earlier preview instructions.

Desktop stores UI preferences, provider settings, and chat history under `%APPDATA%\babel-desktop`. CLI configuration, state, and cache are in that folder's `engine` directory. Nothing is written back to bundled resources. The first launch after this change copies `%APPDATA%\babel-north-star-desktop` into `%APPDATA%\babel-desktop` when the new folder is missing those files, writes `profile-migration.json` only after the copy verifies, and leaves the old folder in place. Files already present in `%APPDATA%\babel-desktop` are not replaced. A failed copy keeps using the old folder. Existing CLI profiles outside this directory are not imported. To use a separate profile, launch:

```bat
"Babel Desktop.exe" "--profile-dir=C:\Babel Profiles\Test One"
"Babel Harness.cmd" "--profile-dir=C:\Babel Profiles\Test One" doctor --json
```

Closing during active work offers **Keep open**, **Keep working in background**, or **Stop and quit**. Restart from the same extracted directory with the same profile. Saved chats and drafts remain in that profile. A repeated submission ID is refused after admission, including after an application restart; an interrupted admission may need a new submission after inspecting the existing session.

## Credential security and project opt-in

- Private provider credentials use Windows-protected storage. There is no plaintext fallback when OS protection is unavailable. An explicitly selected project `.env` remains plaintext.
- Existing keys require an explicit replacement action. Legacy-key migration retains the original private plaintext file for recovery; it does not erase that file.
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
