# Babel Desktop — private Windows preview

This portable preview includes Babel Desktop, the authoritative Babel CLI, prompt assets, production dependencies, and Node 24.13.1. It requires Windows x64. You do not need Node, npm, a source checkout, or a separate CLI build to launch it.

## Install with Setup.exe (per-user, unsigned preview)

The release workflow now builds and attaches the Setup.exe alongside the portable ZIP, so a published release carries both. It performs the same per-user install without manual extraction: Start Menu shortcut, upgrade with rollback, and an entry under Settings -> Apps -> Installed apps -> Babel Desktop for uninstall. It installs only for the current Windows user, requires no administrator rights, and verifies the payload SHA256 before anything is written. Checksum verification confirms the payload bytes, not the publisher: this is still an **unsigned preview** (SmartScreen will warn; see the signing note below). Silent install: run the Setup.exe with the /S switch from a command prompt.

1. Verify the ZIP's SHA256 against the supplied SHA256SUMS.
2. Extract the **entire** ZIP to a writable directory, including one with spaces. Keep the directory structure intact. Do not launch from inside the ZIP.
3. Open **Babel Desktop.exe**. First launch shows setup status. Choose your project with **Open project**.
4. For the default OpenRouter route, create the configuration directory shown in Setup and create a `.env` file there yourself with `OPENROUTER_API_KEY=your-key`. Use your own account and approved model. Do not paste keys into chat, commit them, or share the file. Other supported provider configuration belongs in that same file. Desktop does not import credentials from other apps or checkouts. Explicit process environment credentials are respected.
5. Install and start Docker separately for the default `safe_repo` execution profile. Desktop does not start Docker, change Windows policy, or switch to unrestricted host execution. Project commands may need their own language tools inside the execution environment; these are not installed by this preview.
6. Click **Recheck setup**, then **Use Babel Harness**. Credential presence is not authentication; actual provider errors remain errors. A task may send project content to your configured provider and incur charges. Review Babel's normal run confirmation and tool approvals.

Credential-free local Ollama routes do not require a cloud key. Configure a local model and route separately through Babel's CLI configuration; model reference controls in Desktop do not configure a provider.

For diagnostics without a provider call, open Command Prompt in the extracted folder and run:

```bat
"Babel Harness.cmd" --version
"Babel Harness.cmd" doctor --json
"Babel Harness.cmd" setup --json
```

`Babel CLI.cmd` remains available as a compatibility alias for earlier preview instructions.

By default Desktop stores UI preferences under `%APPDATA%\babel-north-star-desktop`, and CLI configuration/state/cache under its `engine` directory. Nothing is written back to bundled resources. Existing CLI profiles and saved sessions elsewhere are not imported. To use a separate profile, launch:

```bat
"Babel Desktop.exe" "--profile-dir=C:\Babel Profiles\Preview One"
"Babel Harness.cmd" "--profile-dir=C:\Babel Profiles\Preview One" doctor --json
```

Quit by closing the Desktop window. Closing requests cancellation before the application exits; active model-task shutdown is not qualified in this preview. Restart from the same extracted directory with the same profile. Saved chats are read from Babel's own state directory.

## Runtime identity and updates

The right-hand **Runtime** panel shows the exact engine: Desktop version, CLI package version, CLI source commit and working-tree state, engine origin (bundled, development checkout, or advanced entry), the effective execution profile (`safe_repo`), provider/Docker readiness, and the update status. Update status reads **Not checked** until you press a check button; the panel never claims "up to date" without an actual check.

- **Source build (development checkout):** the panel offers **Check for CLI updates** and **Update development CLI**. The update inspects the checkout, refuses dirty, detached, diverged, or untrusted states, fetches `origin`, fast-forwards only (never a reset or a branch change), reinstalls locked dependencies, rebuilds the CLI with the repository's own commands, validates the rebuilt CLI version, and keeps the previous build for rollback. It requires your confirmation before running and never overwrites uncommitted work.
- **Packaged app:** the panel offers **Check for updates**, which queries the official release channel and compares it with the bundled version. The installed bundle is not modified. To update a packaged install, download the newer verified Setup.exe or ZIP and run it as above; automatic in-place updates are deliberately not implemented because a `git pull` inside installed resources would overwrite the app itself.

Checksum verification is not publisher authentication, and neither channel silently installs unsigned code.

This is an **unsigned private preview**, not a public release or a signed installer. Windows SmartScreen may flag an unfamiliar unsigned application. No code-signing identity or SmartScreen reputation is provided. The portable ZIP has no Start Menu entry or uninstaller; the Setup.exe provides both, plus staged upgrade and rollback. Automated in-place updates of a packaged install are not implemented. Do not disable Windows security settings to run it. If your policy blocks unsigned software, retain the artifact for review and wait for a signed distribution.

To remove the portable application, quit it and delete its extracted directory. Profile data persists separately; remove it only if you intentionally want to erase settings and sessions. To update, extract a newer verified preview into a separate directory, keep the same profile, and retain the old build for rollback. Cross-version profile migration is not qualified.

`BUILD.json` identifies the exact source commit and runtime versions. The accompanying qualification note distinguishes tests performed from unqualified behavior. Model inference and paid provider calls are not part of bundle qualification.
