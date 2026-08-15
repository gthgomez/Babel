<!--
status: ACTIVE
last_verified: 2026-07-25
-->
# 09 — Credential Read Deny

## Purpose

Prevent live secrets from entering agent context or session transcripts. The tool-level deny is Layer 1: `permissions.deny` in `.claude/settings.json` (mirrored in `.claude/settings.local.json`) plus the `block-credential-read` PreToolUse hook on Bash/PowerShell. This rule is Layer 2 (behavioral) and covers shell bypass and judgment. Credential access is Class C under `.agents/rules/10-autonomy-policy.md` — an explicit gate or deterministic boundary, never an agent decision.

## Hard rules

1. **Never Read** credential files, including but not limited to:
   - `.env`, `.env.*`, `**/.env`, `**/.env.*`
   - `babel-cli/.env` and variants
   - `*.pem`, `*.p12`, `*.pfx`, `id_rsa`, `id_ed25519`
   - `credentials.json`, `secrets/**`, `.ssh/**`, `.aws/credentials`
2. **Never bypass** the Read deny via Bash/PowerShell (`cat`, `type`, `Get-Content`, `Get-Content -Raw`, Python `open()`, `rg`/`Select-String` dumping full secret file contents).
3. **Never paste** live secret values into chat, commits, handoffs, memory, reports, or tool args.
4. If a task seems to require a secret: **stop**, tell the operator which *variable name* is needed, and let them set it in the environment or a local untracked file outside agent reach.
5. If a secret is accidentally loaded into context: **do not repeat it**; instruct the operator to **rotate** the affected keys; note session id only.

## Allowed alternatives

| Need | Do this instead |
|------|-----------------|
| Confirm `.env` exists | `Test-Path` / `ls` metadata only — no content |
| Which vars are required | Read `.env.example`, docs, or code that *names* vars |
| Debug auth failures | Use error messages + "is VAR set?" checks without printing values |
| Scrub / gitleaks tests | Use **synthetic** fixtures only — never copy live token shapes |

## Enforcement surfaces

| Layer | Where |
|-------|--------|
| Tool deny (Layer 1) | `.claude/settings.json` → `permissions.deny` (Read/Edit/Write of `.env`, keys, certs); mirrored in `.claude/settings.local.json` |
| Hook (Layer 1.5) | `.claude/hooks/block-credential-read.sh` — PreToolUse on Bash/PowerShell |
| Agent rule (Layer 2) | this file (`.agents/rules/09-credential-read-deny.md`) |
| Project entry | `CLAUDE.md` §Environment Gotchas + §Special Rules |
| CI gate | `tools/run-public-secret-scan.ps1` (gitleaks v8.30.1, SHA-256 pinned) |
