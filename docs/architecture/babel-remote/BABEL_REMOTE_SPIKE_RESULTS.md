# Babel Remote — Stage 1 Spike Results

<!--
status: ACTIVE
last_verified: 2026-08-16
-->

Do not read this as “Babel Remote works on a phone.” Loopback unit tests plus one live DeepSeek turn are recorded below. Hardware, Tailscale, Android, and Windows sleep were not executed.

## Provider used

Gateway tests replace `ChatEngine.submitMessageStream` with a stub that captures the message bytes and yields `thinking` / `answer_chunk` / `done`. That confirms the **host calls the real method** with intact UTF-8. It does **not** demonstrate a configured provider HTTP request.

Live provider (2026-08-16 loopback): **DeepSeek** `deepseek-v4-flash`. VERIFIED.

- `babel models ping --json --model deepseek-v4-flash` → `status: pass` (1577 ms).
- `babel remote serve --port 14551` on `127.0.0.1` (after adding `remote` to `KNOWN_TOP_LEVEL_COMMANDS`; without that, argv rewrite turned `remote serve` into `babel run` and rejected `--port`).
- Authenticated `thread.create` + `turn.submit` + WebSocket `turn.event`.
- Unauthenticated `/rpc` → 401. Health `bind` = `127.0.0.1:14551`.
- Stream types: `thinking`, `answer_chunk` (×N), `thought`, `done`, `cell.committed`.
- Reply contained sentinel `BABEL_REMOTE_LIVE_PONG_7f3a` and did **not** echo the full user prompt (old bridge echo path).
- Live prompt SHA-256 `827f826af401127313cfff8d28fd9a42d0b973e9af8ef381b08df29d22e4fcae` (112 UTF-8 bytes). Provider HTTP body hash still not captured from the runner.

## Large-prompt integrity

Fixture: markdown, fenced code, indentation, quotes, backticks, CRLF+LF, emoji/Japanese, JSON, repeated sentinel/pad until ≥100 KiB.

Command: `npx tsx --no-warnings=ExperimentalWarning --test src/bridge/protocolGateway.test.ts` (test: “submits a 100 KB prompt through ChatEngine without corruption”). Independent hash of the same builder: `node` SHA-256 of UTF-8 bytes.

| Boundary | byteLength | SHA-256 | Status |
|---|---|---|---|
| SOURCE (fixture UTF-8) | 102698 | `468542f4343347b7dce0dd0430538b111c6121981645f921c1d65878a350ecf1` | VERIFIED |
| HTTP /rpc received | same (JSON string of that message) | same | VERIFIED (equality assert vs source) |
| ChatEngine.submitMessageStream argument | 102698 | `468542f4343347b7dce0dd0430538b111c6121981645f921c1d65878a350ecf1` | VERIFIED (`SOURCE_SHA256 == CHATENGINE_BOUNDARY_SHA256`) |
| Provider HTTP body | — | — | NOT_VERIFIED (stubbed stream; no runner capture) |

PASS at the last Babel-controlled boundary under test (ChatEngine method argument). FAIL/absent at provider wire.

No intentional canonicalization. `promptFingerprint` was not used.

## Acceptance matrix

| Req | Evidence | Result | Caveat |
|---|---|---|---|
| A REAL EXECUTION | live DeepSeek `deepseek-v4-flash` via `/rpc` + WS `turn.event` | VERIFIED (loopback) | Not Android/Tailscale. Diff-critic annotation appeared in concatenated chunks. |
| B TEXT INTEGRITY 100 KB | protocolGateway test + hashes above | VERIFIED to ChatEngine boundary | Not Android paste; not provider body |
| C AUTH | 401 missing/invalid; WS upgrade without token rejected | VERIFIED (loopback unit) | Query-token leak residual |
| D AUTHORITY | default factory uses mode executionProfile; no new shell/FS APIs | PARTIALLY_VERIFIED | Weak test (method presence); no live policy matrix |
| E INTERRUPTION | `turn.cancel` calls `ChatEngine.cancel` | VERIFIED (gateway test) | Not phone Stop button |
| F RECONNECT | `history.lookup` after submit; WS replaces transport per sessionId | PARTIALLY_VERIFIED | Lookup returns cells (often empty in stub). Duplicate-submit: `command_id`. No phone network flap. |
| G EVENT ORDER | `turn.event.seq` monotonic per turn | VERIFIED in types/host; PARTIALLY_VERIFIED (contract tests emit seq) | Fan-out is process-global |
| H HOST UNAVAILABLE | design: TCP fail; no submit if unreachable | NOT_VERIFIED | Manual script below |
| I SLEEP/WAKE | — | NOT_VERIFIED | Manual script below |
| J PWA BACKGROUNDING | submit is HTTP POST; do not rely on forever WS | DEFERRED design only | No Android measurement |
| K NO PUBLIC EXPOSURE | listen 127.0.0.1; refuse 0.0.0.0 and Funnel env | PARTIALLY_VERIFIED | No live Tailscale Funnel/Serve probe |

## Tests run this session

```
cd babel-cli
npx tsc --noEmit
npx tsx --no-warnings=ExperimentalWarning --test `
  src/bridge/bindGuard.test.ts `
  src/bridge/protocolGateway.test.ts `
  src/bridge/sessionServer.test.ts `
  src/agent/approvalOperation.test.ts `
  src/interactive/execution/chatTransport.test.ts `
  src/protocol/client/contract.test.ts `
  src/protocol/runtimeSurfaces.test.ts `
  src/agent/harnessParityP1P3.test.ts
```

Observed: tsc exit 0; 63 tests pass, 0 fail. VERIFIED.

Full `npm test` (resolver, pipeline, MCP adapter, …): **NOT_VERIFIED** this session.

`src/bridge/*.test.ts` is now included in `npm run test:unit`.

## Limitations

- Spike UI is a single HTML page (`GET /ui`): token, create thread, send, stop. Not Stage 2 product UI.
- Notification fan-out: every authenticated WS receives every `turn.event` in-process.
- WS still requires a bridge `sessionId` from `POST /sessions` in addition to ADR-010 `thread_id`. Transport session ≠ agent thread. Documented residue; not a new domain model.
- Tailscale Serve, Android PWA, Windows sleep: not run.

## Manual scripts (unexecuted)

### Tailscale Serve (operator)

1. `babel remote serve --port 4545 --project <repo> --origin https://<tailscale-serve-host>`
2. Confirm process listens only on 127.0.0.1 (`netstat` / `Get-NetTCPConnection`).
3. `tailscale serve --bg 4545` — **not** `tailscale funnel`.
4. From phone on tailnet, open the Serve URL `/ui`, paste token, create thread, send a short prompt.
5. Expected if a provider is configured: streamed `turn.event`. If not: engine error events, not echo.

Mark HOST_UNAVAILABLE if the laptop is off.

### Sleep/wake

1. Start a turn.
2. Sleep Windows.
3. Wake.
4. Reopen `/ui` or re-POST `history.lookup` / `thread.resume`.
5. Do not resubmit without `command_id` unless the first submit is known unacked.

### PWA backgrounding

1. Send a turn.
2. Background Chrome.
3. Foreground and `history.lookup`.
4. Expect HTTP recovery, not a preserved WS.

## Stage promotion

ITERATE_STAGE_1 — live loopback ChatEngine path is now evidenced; Tailscale/Android/host continuity are not.
