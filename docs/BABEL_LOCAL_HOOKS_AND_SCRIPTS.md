# Babel Local Hooks And Scripts

## Purpose

Document deterministic Phase 3 local-tool flows for Babel Local:
- one Claude Code hook flow
- one Gemini CLI scripted flow

This layer is intentionally bounded:
- no prompt auto-editing
- no router auto-editing
- no changes to compiled-memory generation contracts

## Shared Lifecycle Scripts

Phase 3 introduces two reusable lifecycle scripts:

- `tools/start-local-session.ps1`
- `tools/end-local-session.ps1`

These scripts are deterministic and audit-friendly:
- startup writes one JSON artifact under `runs/local-learning/session-starts/<UTC-date>/`
- shutdown writes one JSON artifact under `runs/local-learning/session-ends/<UTC-date>/`
- canonical outcome logging remains in `runs/local-learning/session-log.jsonl` via `tools/log-local-session.ps1`

## Claude Code Hook Flow (Documented)

### Goal

Run Babel session start and end actions automatically in Claude Code using official hook events (`SessionStart`, `SessionEnd`).

### Hook command scripts

- `tools/claude-hook-session-start.ps1`
- `tools/claude-hook-session-end.ps1`

Both scripts:
- read Claude hook JSON from stdin
- operate only in the local repo
- write deterministic lifecycle artifacts under `runs/local-learning/`

### Example `.claude/settings.json`

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"./tools/claude-hook-session-start.ps1\" -TaskCategory devops -Project global"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"./tools/claude-hook-session-end.ps1\" -Result partial"
          }
        ]
      }
    ]
  }
}
```

### Notes

- `SessionStart` returns `additionalContext` so the session starts with Babel kickoff guidance.
- `SessionEnd` defaults to `Result=partial` because hook payloads do not include final task success semantics.
- hook-based `Result=success` logs a successful session without adding hook-specific failure tags.
- If you need an explicit final outcome after a hook-based partial session, rerun `tools/end-local-session.ps1` manually with `-SessionId <id> -Result success|failed|abandoned`.
- Manual finalization is treated as reconciliation for the same session ID, not as a second analytics record.

## Gemini CLI Scripted Flow (Documented)

### Goal

Use a deterministic script-first workflow around Gemini CLI headless execution.

### PowerShell flow

```powershell
$sessionId = "gemini-local-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")

$null = powershell -ExecutionPolicy Bypass -File .\tools\start-local-session.ps1 `
  -TaskCategory research `
  -Project global `
  -Model gemini `
  -ClientSurface gemini_cli `
  -SessionId $sessionId `
  -Format json

$taskPrompt = @"
Read BABEL_BIBLE.md first. Then read PROJECT_CONTEXT.md and prompt_catalog.yaml.
Use Babel to select the right stack and answer the requested task.
"@

$null = gemini --prompt $taskPrompt --output-format json
$result = if ($LASTEXITCODE -eq 0) { "success" } else { "failed" }

powershell -ExecutionPolicy Bypass -File .\tools\end-local-session.ps1 `
  -SessionId $sessionId `
  -Result $result `
  -Format json
```

### Notes

- Keep the prompt text in versioned files if the workflow becomes shared/team-wide.
- Prefer explicit `SessionId` values in automation so logs are easy to trace.
- Use `tools/analyze-local-sessions.ps1` to summarize outcomes before proposing Babel changes.
- The documented Gemini flow is script-first rather than hook-based, so explicit final result selection happens in the wrapper script.

## Verification

Run the phase-specific regression script:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-local-hooks-and-scripts.ps1
```
