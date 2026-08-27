# Babel Remote — Repository Reconciliation

<!--
status: ACTIVE
last_verified: 2026-08-16
-->

Hypothesis: the authenticated loopback bridge can be the transport for ADR-010 and the real ChatEngine. Assumed YES until code proved otherwise. Code agrees.

## Evidence ledger

CLAIM: ADR-010 catalog is thread.create/resume, turn.submit/cancel, history.lookup, turn.event, cell.committed.
FILE: docs/adr/ADR-010-app-server-protocol.md (message catalog). STATUS: VERIFIED.
IMPLICATION: Do not invent a competing /api/v1 namespace.

CLAIM: Historical ADR rejected WebSocket for D1/D2 stdio-first delivery, not as a forever ban.
FILE: ADR-010 Alternatives “WebSocket transport first”. STATUS: VERIFIED.
IMPLICATION: HTTP/WS may carry the same catalog.

CLAIM: In-process host maps turn.submit to ChatEngine.submitMessageStream.
FILE: babel-cli/src/protocol/client/host.ts handleProtocolRequest. STATUS: VERIFIED.
IMPLICATION: Semantic authority stays in the host.

CLAIM: TUI daily path does not require the HTTP bridge.
FILE: interactive execution / ChatEngine. STATUS: VERIFIED.
IMPLICATION: Remote is an additional client.

CLAIM: ChatEngine.submitMessageStream is the live engine entry.
FILE: babel-cli/src/agent/chatEngine.ts. STATUS: VERIFIED.
IMPLICATION: Spike must call this, not echo.

CLAIM: HTTP/WS BridgeServer existed as library plus tests; no CLI start previously.
FILE: babel-cli/src/bridge/sessionServer.ts BridgeServer.start. STATUS: VERIFIED.
IMPLICATION: Reuse this server; do not add a second HTTP app.

CLAIM: Bridge previously echoed prompts (not ChatEngine). STATUS: VERIFIED (pre-spike).
IMPLICATION: Echo is not canonical; replaced.

CLAIM: Bridge bind is hardcoded 127.0.0.1.
FILE: sessionServer.ts listenHost. STATUS: VERIFIED.
IMPLICATION: No 0.0.0.0.

CLAIM: Auth is bearer / query token via ~/.babel/bridge.json.
FILE: babel-cli/src/bridge/auth.ts verifyToken. STATUS: VERIFIED.
IMPLICATION: Tailscale identity is extra, not a replacement.

CLAIM: CLI `events ide-bridge` is a read-only snapshot, not this HTTP server.
FILE: babel-cli/src/services/ideBridge.ts. STATUS: VERIFIED.

CLAIM: Daemon reuses protocol host over NDJSON IPC.
FILE: protocol/client + runtimeSurfaces.test.ts. STATUS: VERIFIED.
IMPLICATION: Do not add a third server.

CLAIM: Thread store + history.lookup already exist.
FILE: babel-cli/src/services/threadStore/. STATUS: VERIFIED.
IMPLICATION: Reconnect uses this, not a new session DB.

CLAIM: promptFingerprint is policy/system provenance, not user-message bytes. STATUS: VERIFIED.
IMPLICATION: Integrity uses hashUserMessage.

CLAIM: Session event user_submitted stores a 500-char preview.
FILE: sessionEvents.ts. STATUS: VERIFIED.
IMPLICATION: Full bytes live on turn.submit.

CLAIM: Completions/honesty/verifier stay in ChatEngine. STATUS: VERIFIED.
IMPLICATION: Stage 2 exposes; Stage 1 does not rebuild.

CLAIM: Chat MCP tools skip approval prompts.
FILE: chatEngine.ts isMcpChatAction branch (~3724). STATUS: VERIFIED.
IMPLICATION: Confirmed hole; not silently enabled for remote.

CLAIM: workspaceManager.resolveApprovedWorkspacePath is OpenClaw-oriented. STATUS: VERIFIED.
IMPLICATION: Spike uses serve-time registered root (workspaceBound.ts).

## Live path (Stage 1)

Android browser/PWA (or curl)
to Tailscale Serve HTTPS (reachability; NOT_VERIFIED this session)
to http://127.0.0.1:port BridgeServer (loopback only)
to POST /rpc or WS /ws?sessionId=<session-token> (transport)
to ProtocolGateway.dispatch
to handleProtocolRequest (ADR-010)
to thread.create or turn.submit
to hashUserMessage (ChatEngine boundary)
to ChatEngine.submitMessageStream(message)
to existing provider / tools / policy / approvals
to mapChatEventToTurnStreamEvent
to turn.event (seq) plus cell.committed
to WS subscribers / HTTP response for RPC

Exact symbols:

- CLI: babel-cli/src/commands/remoteCommands.ts registerRemoteCommands (babel remote serve)
- Bind guard: babel-cli/src/bridge/bindGuard.ts assertLoopbackBind, assertRemoteListenConfig
- HTTP/WS: babel-cli/src/bridge/sessionServer.ts BridgeServer
- RPC body cap: babel-cli/src/bridge/protocolGateway.ts readLimitedBody, MAX_RPC_BYTES (2 MiB)
- Workspace authz: babel-cli/src/bridge/workspaceBound.ts assertAllowedProjectRoot
- Semantics: babel-cli/src/protocol/client/host.ts handleProtocolRequest
- Integrity: babel-cli/src/protocol/messageIntegrity.ts hashUserMessage
- Event map: babel-cli/src/protocol/mapChatEvent.ts mapChatEventToTurnStreamEvent
- Engine: babel-cli/src/agent/chatEngine.ts submitMessageStream, cancel
- Idempotency: host.ts command_id plus idempotency map

## What was reused

- ADR-010 method catalog (no new methods; optional TurnSubmitParams.command_id for idempotency only)
- In-process protocol host
- BridgeServer loopback HTTP/WS plus bearer auth
- ChatEngine factory (defaultEngineFactory uses executionProfile from descriptor mode)
- Thread store / history.lookup
- Existing ChatEngine.cancel
- Existing approval session types (hardened, not replaced)

## What was fixed

- Prompt echo path replaced with ProtocolGateway to real submitMessageStream
- mapChatEvent moved to protocol/ so the host does not import TUI transport
- Loopback plus Funnel-env fail-closed
- project_root must sit inside the registered workspace root (authorization, not sandbox)
- Optional command_id replay / mutation reject
- turn.cancel returns TURN_NOT_IN_PROGRESS when idle
- GET /health unauthenticated, no token leak; GET /ui spike PWA without embedding secrets
- src/bridge/*.test.ts added to npm run test:unit

## What was explicitly NOT built

- New REST catalog / /api/v1
- New session manager or SQLite
- AgentAdapter / provider router / MCP router / scheduler / fallback
- PTY / remote desktop / screen capture
- Tailscale concepts inside ADR-010
- Public bind / Funnel
- Remote approval UI / mobile ALLOW_SESSION
- Verifier UI (Stage 2)
- Native Android app
- Separate DeepSeek/BYO-key remote adapters
- ACP as internal architecture

## ACP comparison (compatibility target, not authority)

- Session create: thread.create vs session/new — CAN MAP LATER
- Resume: thread.resume + history.lookup vs session/resume + replayFrom — CAN MAP LATER
- Prompt: turn.submit UTF-8 string vs session/prompt content blocks — CAN MAP LATER
- Stream: turn.event + seq vs session/update — CAN MAP LATER
- Cancel: turn.cancel vs session/cancel — ALIGNS
- Tool calls: ChatEvent tool_* in turn.event vs ACP tool-call updates — CAN MAP LATER
- Permissions: local JIT; catalog permission.request unused on remote vs session/request_permission — BABEL-SPECIFIC now
- Capability negotiation: none vs required capability objects — ACP-SPECIFIC
- Remote transports: loopback HTTP/WS + tailnet vs editor-agent — NOT NEEDED for Stage 1
- Completion honesty / verifier: ChatEngine / kernel — BABEL-SPECIFIC
- Host execution authority: Windows Babel process — ALIGNS in spirit

Possible future: Babel internals then a thin ACP edge. Not: ACP becomes Babel internals.

## Implementation status vs ADR-010

- Typed catalog D1: Complete (pre-existing)
- In-process host D2 stub: Complete (pre-existing)
- Loopback HTTP/WS transport for the same catalog: Partial — this spike (unit/gateway tests VERIFIED; Tailscale/Android/live provider NOT_VERIFIED)
- Standalone stdio babel-app-server: Still Open
- Thin-client TUI over stdio: Still Open
