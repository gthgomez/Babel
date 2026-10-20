# Antigravity CLI (AGY) — offline evidence and gaps

Status: **OFFLINE FOUNDATION** (catalog + evidence only; Babel shared-owner execution **not** implemented).

Primary sources (fetched for this slice; installed host version **not** qualified here):

| Topic | Source | Verified claim |
| --- | --- | --- |
| Headless stdin / unsupported control traffic | [Headless → Unsupported messages](https://antigravity.google/docs/cli/headless#unsupported-messages) | `control_request` / `control_response` → `ERROR`, session ends, **exit 2**; stream-json prompts are **stdin** `user` events (not `-p` while streaming). |
| Tool veto / approval surface | [Hooks → PreToolUse](https://antigravity.google/docs/hooks/#pretooluse) | Separate hook JSON on stdin/stdout with `toolCall.name`/`args`, `stepIdx`, `conversationId`; decisions include `deny`, `allow`, `auto_approve`, `ask`, `force_ask`, `deny_unless_prior_grant`. |
| Remote control | [Remote control (CLI tab)](https://antigravity.google/docs/remote-control?tab=cli) | Google **remote product**; not documented as an embeddable tunnel API for Babel. |
| CLI changelog | [Changelog](https://antigravity.google/docs/changelog/) | CLI **v1.1.x** line (e.g. 1.1.8 / 1.1.15 / 1.1.20 cited in campaign); Antigravity **app 2.x** is a different surface. |

## Babel position (this repository)

- `buildAntigravityAdapterDescriptor()` keeps **all** `HarnessCapabilityFlags` false, including `start`, `approve`, and `attachLive`.
- `unsupportedReason` states offline foundation + documented headless constraints + live-attach/remote-control scope.
- Catalog `installation` is `not_implemented`; **no** host `agy` probe or subprocess on `remote.capabilities`.
- **No** reserved `antigravity-*` harness profile id in this slice.

## Documented headless control model (gap vs Command Code / OpenCode ACP)

| Area | Official behavior | Babel gap |
| --- | --- | --- |
| Wire protocol | NDJSON `stream-json` on stdin/stdout for multi-turn **one process** | No managed `agy` child, no transcript replay harness yet. |
| Control plane | `control_request` / `control_response` **rejected** (exit 2) | Cannot reuse ACP JSON-RPC negotiation; need stream-json mapper if execution is added later. |
| Permissions | Documented workspace read/write auto-allow; **not** equivalent to missing Babel `skip-permissions` enforcement | Babel must still bind approvals to remote digest; hook `PreToolUse` is a **parallel** veto path. |
| Usage metadata | JSON envelope `usage` fields; `num_turns` is **session-cumulative** | Must not double-count snapshots across turns; soft-denial **exit 0** is not task success. |
| History / resume | Not proven for unmanaged enumeration or live attach | `readHistory` / `resumeStopped` remain false until contract + evidence exist. |

## Hooks — known vs unproven

**Known (documented):** workspace `.agents/hooks.json`, global `~/.gemini/config/hooks.json`, CLI settings, plugin hooks; `PreToolUse` matcher regex; hook timeout default 30s.

**Unproven for Babel certification (needs live/trace evidence):** fail-closed behavior on hook timeout/malformed stdout; ordering when multiple hooks match; descendant process coverage; isolation when workspace is writable (tampered hook configs).

## Remote / live attach

- Unmanaged TUI attach and Google Remote Control stay **unsupported** on the shared-owner path (`attachLive=false`).
- No harness process launch, credential changes, or paid calls in this slice.

## Code map

| File | Role |
| --- | --- |
| `babel-cli/src/bridge/antigravityOwnCliAdapter.ts` | Static catalog descriptor + disabled capabilities |
| `babel-cli/src/bridge/harnessAdapterRegistry.ts` | Wires AGY into remote capabilities payload (no probe) |
