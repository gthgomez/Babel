# ADR-010: App-Server Protocol Sketch

<!--
status: ACTIVE
last_verified: 2026-08-17
-->
**Status:** Accepted for the protocol contract; runtime transport remains partial
**Date:** 2026-06-30  
**Deciders:** Babel team  

## Context

Babel's TUI currently embeds `ChatEngine` in-process: `BabelRepl` and
`ConversationalRenderer` import the agent directly, stream `ChatEvent`s through
`consumeChatStream()`, and persist transcript rows via `HistoryTranscript`. This
works for a single-terminal REPL but blocks:

- **Protocol-separated UI** (Phase D2): TUI as a thin client over a stable wire contract
- **Future consumers**: IDE bridge, web UI, headless automation — all need the same agent API
- **Durability alignment** (Phase D3): thread-store operations (`createThread`,
  `appendTurnCells`, `loadThreadCells`, `listThreads`) need a transport-agnostic contract

The industry pattern is to separate agent and UI via a stdio JSON-RPC 2.0 process that
hosts the agent while the TUI is a thin client. Babel should follow the same shape for
architectural parity and to reuse established client patterns.

Phase D1 is complete: the typed catalog and round-trip tests live under
`babel-cli/src/protocol/`. D2 has an in-process JSON-RPC host/client stub used by
the chat transport tests; a standalone stdio app-server and thin-client TUI remain
future work. D3 owns durable thread-store integration. This ADR defines the message
catalog shared by those surfaces.

## Decision

Adopt **stdio newline-delimited JSON-RPC 2.0** as the Babel app-server transport, with a
fixed message catalog in `babel-cli/src/protocol/`.

### Transport

The **semantic contract** is the message catalog below. Transports are not semantic authority.

| Property | Stdio (original D1/D2 decision) | Loopback HTTP/WS (2026-08-16 amendment) |
|----------|----------------------------------|------------------------------------------|
| Encoding | UTF-8, one JSON object per line (NDJSON) | UTF-8 JSON-RPC objects |
| Direction | Client → server on stdin; server → client on stdout | Client `POST /rpc`; server notifications on `WS /ws` |
| Framing | JSON-RPC 2.0 request/response; server-initiated notifications for streaming | Same JSON-RPC catalog |
| Version constant | `BABEL_PROTOCOL_VERSION = '1.0.0'` | Same |
| Binding | Child process, no port | `127.0.0.1` only; application bearer auth |
| Status | Open (standalone `babel-app-server` not shipped) | Partial (bridge gateway + tests; live Tailscale/phone/provider not claimed) |

Stderr is reserved for human-readable server logs (not part of the protocol).

Reachability (Tailscale Serve, etc.) is **outside this ADR**. Do not embed tailnet concepts in the catalog.

Large complete messages travel as HTTP JSON-RPC request bodies (`turn.submit.params.message`), not as simulated keystrokes. WebSocket carries the same methods plus `turn.event` / `cell.committed` notifications. Optional `command_id` on `turn.submit` is an idempotency key, not a new method.

### Message catalog

#### Requests (client → server, expect JSON-RPC response)

| Method | Params | Result | Maps to |
|--------|--------|--------|---------|
| `thread.create` | `project_root`, optional `task`, `model` | `{ thread_id }` | D3 `createThread` + new `ChatEngine` |
| `thread.resume` | `thread_id`, optional `project_root` | `{ thread_id, turn_count }` | D3 `loadThreadCells` + `ChatEngine` hydration |
| `turn.submit` | `thread_id`, `message`, optional `command_id` | `{ thread_id, turn_id }` | `ChatEngine.submitMessageStream()` |
| `turn.cancel` | `thread_id` | `{ thread_id, turn_id, cancelled }` | `ChatEngine` abort / generation cancel |
| `history.lookup` | `thread_id`, optional `cell_id`, `turn_id`, `limit`, `cursor` | `{ cells, cursor?, has_more? }` | D3 `loadThreadCells` with filters |
| `approval.decide` | `approval_id`, `decision`, `thread_id`, `turn_id`, optional `operation_digest` | `{ approval_id, decision, consumed }` | Remote V1 consume of pending operation digest (`allow_once` / `deny` only) |
| `workspace.changes` | `thread_id` | `{ available, files, diff, reason? }` | Existing Git status/diff in the thread project root |
| `verification.lookup` | `thread_id` | `{ status, reason, has_machine_evidence }` | Stored machine evidence only; missing evidence is `NOT_VERIFIED` |

#### Notifications (server → client, no `id` field)

| Method | Params | When emitted | Maps to |
|--------|--------|--------------|---------|
| `turn.event` | `thread_id`, `turn_id`, `seq`, `event` | During an active turn | Each `ChatEvent` from `submitMessageStream()` |
| `cell.committed` | `thread_id`, `turn_id`, `cells` | Turn ends (completed, failed, or cancelled) | `HistoryTranscript.finishTurn()` / `abortTurn()` → D3 `appendTurnCells` |

### Streaming model

1. Client sends `turn.submit` → server responds immediately with `{ turn_id }`.
2. Server streams `turn.event` notifications with monotonically increasing `seq` per turn.
3. On terminal `ChatEvent` (`done`, `failed`, or cancel path), server emits `cell.committed`
   with the committed `HistoryCellRecord[]` for that turn, then allows the next `turn.submit`.

`turn.event` carries normalized `TurnStreamEvent` values that mirror `ChatEvent` from
`chatEngine.ts` one-to-one (same `type` strings and field names). D2 TUI clients can feed
these into existing `consumeChatStream` dispatch logic without a second normalization layer.

### Error taxonomy

Standard JSON-RPC errors (-32700 … -32603) plus application codes (-32000 … -32099):

| Code | Name | When |
|------|------|------|
| -32000 | `THREAD_NOT_FOUND` | Unknown `thread_id` |
| -32001 | `TURN_IN_PROGRESS` | `turn.submit` while a turn is active |
| -32002 | `TURN_NOT_IN_PROGRESS` | `turn.cancel` with no active turn |
| -32003 | `THREAD_EXISTS` | `thread.create` collision (reserved) |
| -32004 | `PROJECT_ROOT_MISMATCH` | `thread.resume` with wrong `project_root` |
| -32005 | `CELL_NOT_FOUND` | `history.lookup` anchor `cell_id` missing |

### Thread identity

`thread_id` is an opaque string. On create, the server may use `ChatEngine.getEngineRunId()`
or a D3 thread-store UUID; clients treat it as opaque. `turn_id` is a monotonic integer per
thread, aligned with `HistoryCellRecord.turn_id`.

### Migration path (D2)

The current D2 stub is in-process: `BabelRepl` can keep importing `ChatEngine`
directly while `BABEL_PROTOCOL_CLIENT=1` enables protocol notifications and thread
allocation. The standalone stdio process remains opt-in future work.

## Alternatives Considered

### WebSocket transport first

Rejected for D1/D2 **initial delivery**. Stdio JSON-RPC requires no port binding
and works naturally for `babel-tui` spawning `babel-app-server` as a child process. WebSocket
may be added later as an optional transport behind the same message types.

**Amendment (2026-08-16):** loopback HTTP `POST /rpc` plus authenticated WebSocket
`/ws` now exist as that optional transport for Babel Remote Stage 1. This does not
replace the stdio decision, does not promote WebSocket to semantic authority, and
does not claim the D2 out-of-process TUI exit is complete. Historical rejection
above remains the D1/D2 rationale.

**Amendment (2026-08-17):** Babel Remote V1 adds backward-compatible methods
`approval.decide`, `workspace.changes`, and `verification.lookup`. Pending
approvals reuse the existing `permission.request` / `permission.respond`
notifications with optional digest identity fields. V1 WebSocket credentials are
short-lived tickets minted over authenticated HTTP; the long-lived bearer is not
part of the V1 browser URL. These methods do not replace the catalog's existing
thread/turn/history contract.

### gRPC / protobuf

Rejected. Babel's existing daemon IPC uses JSON. Protobuf adds code-gen
and debugging friction without benefit at sketch stage.

### Flat REST over HTTP

Rejected. Streaming turn events and bidirectional cancel require long-lived connections or
SSE hacks; JSON-RPC notifications are a cleaner fit.

### Embed protocol types inside `ChatEngine`

Rejected. `src/protocol/` is a leaf module consumed by server (D2), TUI client (D2), and
future bridges. `ChatEngine` should not depend on wire format.

## Consequences

### Consumers

| Consumer | Phase | Uses |
|----------|-------|------|
| `babel-tui` (thin client) | Future | All requests + `turn.event` / `cell.committed` |
| `babel-app-server` | Future | Standalone handlers mapping to `ChatEngine` + D3 store |
| IDE / web UI | Future | Same types; may use socket transport later |
| Contract tests | D2 | Round-trip per message type against mock server |

### Non-goals (explicit)

- Standalone `babel-app-server` process implementation (still Open)
- Public Internet binding, Tailscale Funnel, or `0.0.0.0` listeners
- Authentication or multi-tenant session management as a product platform (loopback bearer auth is transport-only)
- Wiring into `BabelRepl` or changing TUI runtime behavior
- `thread.list`, fork/backtrack messages (Phase D4)
- Treating Tailscale, ACP, or a REST `/api/v1` catalog as this protocol

Historical non-goal “WebSocket or TCP socket transport” applied to D1/D2 initial
delivery. Loopback HTTP/WS is recorded in the Transport amendment above; it is
not a second catalog.

### Compliance

- New wire messages require an ADR amendment or successor ADR.
- `TurnStreamEvent` must stay aligned with `ChatEvent`; breaking changes need a protocol
  version bump (`BABEL_PROTOCOL_VERSION`).
- `cell.committed` payloads must use `HistoryCellRecord` from `src/ui/historyCells/types.ts`
  — the D3 persistence schema is the wire schema.
- D2 server implementation must not extend the catalog without updating `src/protocol/` and
  this ADR.

## Compliance

- Phase D1 exit: types in `src/protocol/` compile; `protocol.test.ts` passes. **Complete.**
- D2 stub exit: in-process host/client contract tests cover the catalog. **Complete.**
- D2 transport exit: REPL chat works with an out-of-process server; contract suite covers
  every method and notification in this catalog. **Open.**
- Loopback HTTP/WS gateway for the same catalog (`babel remote serve`): **Partial**
  (see `docs/architecture/babel-remote/`). Not a D2 transport exit.
