# Babel Remote — Stage 0 Coverage

<!--
status: ACTIVE
last_verified: 2026-08-16
-->

Evidence labels: **VERIFIED** (this session, cited source) · **PARTIALLY_VERIFIED** · **NOT_VERIFIED** · **DEFERRED**.

This is a go/no-go gate, not a product roadmap. Uncovered boxes are not automatically requirements.

## Sources consulted (2026-08-16)

| Product | Source | Status |
|---|---|---|
| Claude Code Remote Control | Official docs: https://code.claude.com/docs/en/remote-control | VERIFIED (fetched) |
| Codex remote | Official: https://developers.openai.com/codex/remote-connections and https://openai.com/index/work-with-codex-from-anywhere/ | VERIFIED (fetched summaries + official pages) |
| Cursor Android / agents | Cursor forum + `cursor.com/agents` coverage; no native Android app in official replies | PARTIALLY_VERIFIED (secondary sources; Android PWA path is consistent) |
| Antigravity CLI | Official: https://www.antigravity.google/docs/cli/overview/ | VERIFIED (fetched) |
| Babel today | This repository | VERIFIED (code) |
| Chrome Remote Desktop “Send text” | Original pain statement; not re-measured this session | NOT_VERIFIED (accepted as the motivating failure mode, not as new lab data) |

## Workflow questions

1. Start or continue a **local** coding-agent session from Android?
2. Paste/send very long prompts as **text payloads** (not simulated keystrokes)?
3. Supervise streaming progress?
4. Inspect structured tool/action state?
5. See repository changes/diffs?
6. See verification / completion honesty state?
7. Respond to permission requests?
8. Operate **providers already mediated by Babel**?
9. Requires manipulating a desktop/terminal UI?
10. Materially improves the CRD “Send text” failure?

Legend: **Y** yes · **N** no · **P** partial · **?** unknown from cited sources · **n/a**

| Q | Claude Code RC | Codex remote / ChatGPT mobile | Cursor Android (`cursor.com/agents`) | Antigravity CLI | Babel today |
|---|---|---|---|---|---|
| 1 | Y — local Claude Code session; Android app + claude.ai/code | Y — ChatGPT mobile Remote to Mac/Windows host (Windows mobile host support historically lagged; treat as P if host is Windows-only) | P — Android reaches **cloud** agents / worker dashboard, not a first-class local Babel/Cursor-desktop Remote Control for Android | P — SSH/tmux/TUI; not a structured phone client | N — TUI/REPL + loopback bridge only |
| 2 | Y — messages/files/images as payloads | Y — app messages, not CRD keystrokes | Y — web prompt box | N — terminal input / send-keys class | N before this spike; HTTP `turn.submit` after |
| 3 | Y | Y | Y (agent dashboard) | P (TUI attach) | P — TUI locally; remote stream wired, live phone **NOT_VERIFIED** |
| 4 | Y (tools/subagents in RC UI) | Y (threads, plugins, terminal/diff in Codex mobile claims) | P (approvals/outputs; not a full IDE) | P (TUI) | P — `turn.event` maps `ChatEvent`; phone UI does not yet render tools |
| 5 | P (local FS stays on host; UI is a window into the session) | Y claimed (diffs) | Y for cloud PRs/reviews | N/P via terminal | P — `file_changed` events exist; Stage 2 UI **DEFERRED** |
| 6 | N/P — Claude honesty ≠ Babel completion-gate | N — not Babel verifier | N | N | N on phone — Babel owns it locally; Stage 2 **DEFERRED** |
| 7 | Y | Y | Y (cloud agent steps) | P (TUI prompts) | Local JIT yes; remote approval UI **DEFERRED** (ALLOW_SESSION forbidden) |
| 8 | N — Claude login only; API keys / `ANTHROPIC_BASE_URL` gateways explicitly unsupported | N — ChatGPT/Codex account | N — Cursor cloud/worker | N — Google/Antigravity | **This is the gap** — DeepSeek/BYO-key/ChatEngine policy stay on the Babel host |
| 9 | N for the RC client; host terminal must stay running | N for the phone app; host app/daemon must stay up | N for the PWA | **Y** — SSH/tmux is the remote story | N intended (browser/PWA) |
| 10 | Y for Claude sessions | Y for Codex sessions | Y for Cursor cloud agents | N — still character/TUI shaped | Y **if** Babel ChatEngine is the session you actually run |

## What existing tools already cover

Claude Code Remote Control is a structured (not CRD) window into a **local Claude Code** session from Android/web. Official docs: outbound relay, no inbound ports, host filesystem/MCP stay local, reconnect after laptop sleep/network drop, message + file/image attach. Subscription/`/login` required; API-key and custom base URL paths are unsupported.

Codex Remote / ChatGPT mobile Remote is a structured window into **Codex/ChatGPT host** sessions (QR pairing; experimental CLI `codex remote-control` exists and official pages disagree on whether CLI setup is supported — treat CLI pairing as PARTIALLY_VERIFIED).

Cursor on Android is a **cloud-agent PWA** (`cursor.com/agents`), not a documented equivalent of “drive the local Windows Cursor/Babel ChatEngine.” Native Cursor mobile is iOS-first.

Antigravity CLI’s documented remote usability is **native SSH, tmux, multiplexers** — the class of interface that recreates the CRD/keystroke problem.

None of these attach to Babel’s ChatEngine, Babel policy, Babel approvals, or Babel verifier/honesty state.

## Uncovered workflow (the only one that clears the value test)

**Name:** Supervise an **already-local Babel ChatEngine session** from Android, submitting complete UTF-8 prompts as payloads, while execution/credentials/policy stay on the Windows Babel host.

**VALUE factors (qualitative, not a fake numeric threshold):**

| Factor | Assessment |
|---|---|
| Frequency | Recurring whenever the operator leaves the desk mid-Babel-session (the same job Claude/Codex remotes exist to serve) |
| Pain severity | High when the session is Babel-specific: CRD “Send text” corrupts long prompts; SSH/tmux is the same failure class |
| Session importance | High — ChatEngine is Babel’s daily path |
| Intervention value | High for paste/send, stop, stream, later approve-once and verification visibility |
| Cheapest existing alternative | Claude RC / Codex remote / Cursor agents **do not operate Babel-mediated providers**. Switching the session to Claude/Codex is a product change, not a remote-control fix |

**Not promoted to requirements:** a generic agent OS, PTY platform, provider-neutral `AgentAdapter`, MCP router, Antigravity wrap, or “cover every matrix N.”

## GO / NO_GO

**GO** — proceed to Stage 1 (reconcile existing loopback bridge + ADR-010 + ChatEngine).

**Not NO_GO:** Claude covering Claude well is expected and is not a kill switch.

## Stage 3 promotion rule (do not implement now)

A second heterogeneous integration (for example Antigravity, if usage evidence shows SSH/tmux is the remaining pain) is allowed only after Stage 1–2 Babel Remote is used for real. Only then extract the smallest shared interface. Do not design `AgentAdapter` in advance.

## ACP

Investigate later as a **compatibility edge**, not as Babel internals. Official ACP v2: `session/new|resume|prompt|cancel`, `session/update`, `session/request_permission`, capability objects. Remote transports in ACP are not Babel’s spike transport. See the comparison table in `BABEL_REMOTE_REPO_RECONCILIATION.md`.
