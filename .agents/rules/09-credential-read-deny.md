<!--
status: ACTIVE
last_verified: 2026-07-25
-->
# 09 — Credential Read Deny

## Purpose

Prevent live secrets from entering agent context or session transcripts. Tool permission deny is Layer 1; this rule is Layer 2 (behavioral) and covers shell bypass.

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
6. If a secret is committed or pushed: follow `.agents/rules/05-github-workflow.md` §Pushed-secret incident. Treat the credential as compromised and rotate/revoke. This file does not authorize history rewrite; Git cleanup and credential containment are separate problems.

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
| Agent rule | this file (`.agents/rules/09-credential-read-deny.md`) |
| Project entry | `CLAUDE.md` §Environment Gotchas + §Special Rules |
| CI gate | `tools/run-public-secret-scan.ps1` (gitleaks v8.30.1, SHA-256 pinned) |
