# Babel Desktop — private Windows preview

This portable preview includes Babel Desktop, the authoritative Babel CLI, prompt assets, production dependencies, and Node 24.13.1. It requires Windows x64. You do not need Node, npm, a source checkout, or a separate CLI build to launch it.

1. Verify the ZIP's SHA256 against the supplied SHA256SUMS.
2. Extract the **entire** ZIP to a writable directory, including one with spaces. Keep the directory structure intact. Do not launch from inside the ZIP.
3. Open **Babel Desktop.exe**. First launch shows setup status. Choose your project with **Open project**.
4. For the default OpenRouter route, create the configuration directory shown in Setup and create a `.env` file there yourself with `OPENROUTER_API_KEY=your-key`. Use your own account and approved model. Do not paste keys into chat, commit them, or share the file. Other supported provider configuration belongs in that same file. Desktop does not import credentials from other apps or checkouts. Explicit process environment credentials are respected.
5. Install and start Docker separately for the default `safe_repo` execution profile. Desktop does not start Docker, change Windows policy, or switch to unrestricted host execution. Project commands may need their own language tools inside the execution environment; these are not installed by this preview.
6. Click **Recheck setup**, then **Use Babel CLI**. Credential presence is not authentication; actual provider errors remain errors. A task may send project content to your configured provider and incur charges. Review Babel's normal run confirmation and tool approvals.

Credential-free local Ollama routes do not require a cloud key. Configure a local model and route separately through Babel's CLI configuration; model reference controls in Desktop do not configure a provider.

For diagnostics without a provider call, open Command Prompt in the extracted folder and run:

```bat
"Babel CLI.cmd" --version
"Babel CLI.cmd" doctor --json
"Babel CLI.cmd" setup --json
```

By default Desktop stores UI preferences under `%APPDATA%\babel-north-star-desktop`, and CLI configuration/state/cache under its `engine` directory. Nothing is written back to bundled resources. Existing CLI profiles and saved sessions elsewhere are not imported. To use a separate profile, launch:

```bat
"Babel Desktop.exe" "--profile-dir=C:\Babel Profiles\Preview One"
"Babel CLI.cmd" "--profile-dir=C:\Babel Profiles\Preview One" doctor --json
```

Quit by closing the Desktop window. Active tasks are cancelled before shutdown. Restart from the same extracted directory with the same profile. Saved chats are read from Babel's own state directory.

This is an **unsigned private preview**, not a public release or a signed installer. Windows SmartScreen may flag an unfamiliar unsigned application. No code-signing identity, SmartScreen reputation, automated updater, Start Menu registration, or uninstaller is provided. Do not disable Windows security settings to run it. If your policy blocks unsigned software, retain the artifact for review and wait for a signed distribution.

To remove the portable application, quit it and delete its extracted directory. Profile data persists separately; remove it only if you intentionally want to erase settings and sessions. To update, extract a newer verified preview into a separate directory, keep the same profile, and retain the old build for rollback. Cross-version profile migration is not qualified.

`BUILD.json` identifies the exact source commit and runtime versions. The accompanying qualification note distinguishes tests performed from unqualified behavior. Model inference and paid provider calls are not part of bundle qualification.
