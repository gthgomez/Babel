# Babel Remote V1 — Implementation

<!--
status: ACTIVE
last_verified: 2026-08-17
-->

Productization of the Stage-1 loopback spike into a supervisory PWA on the
existing ADR-010 → ProtocolGateway → ChatEngine path. This is not a second
remote API.

## Control plane

```
phone / mobile browser
  → Tailscale Serve (operator reachability)
  → 127.0.0.1 BridgeServer
  → POST /rpc  (ADR-010 JSON-RPC)
  → POST /ws/ticket then WS /ws?sessionId&ticket
  → ProtocolGateway (thread-scoped fan-out)
  → Protocol host / ChatEngine
```

`babel remote serve` still fail-closes for `0.0.0.0` and Funnel flags.

## V1 additions

| Area | What shipped |
|---|---|
| Auth | Authenticated `POST /ws/ticket` mints a 30s single-use ticket. V1 UI never puts the long-lived bearer in a URL. |
| Isolation | `ProtocolGateway.subscribe` delivers `turn.event` only to the ticket-bound thread. Disconnect unsubscribes. Replacement transport closes the previous socket. |
| Reconnect | Client state machines + `command_id` idempotency. Ambiguous submit → UNKNOWN, no auto-resubmit. |
| Approval | `approval.decide` consumes `ALLOW_ONCE` / `DENY` against the existing operation digest. `ALLOW_SESSION` is rejected. |
| MCP | Remote surface fail-closes ChatEngine chat MCP (local TUI path unchanged). |
| Truth | `workspace.changes` reads Git status/diff. `verification.lookup` uses `mapVerificationEvidence` (missing evidence is `NOT_VERIFIED`, never PASS). |
| UI | `/ui` installable PWA: connection header, in-memory token, composer, Send/Stop, safe transcript, approval card, files/diff/verification. SW caches shell only. |

## Protocol amendment

Backward-compatible ADR-010 methods: `approval.decide`, `workspace.changes`,
`verification.lookup`. Pending approvals reuse `permission.request`.

## Non-goals still true

No public bind, no Funnel, no second agent protocol, no provider keys in the
PWA, no remote `ALLOW_SESSION`, no React/Vite/Next stack.
