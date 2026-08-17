# Babel Remote — Security Model (Stage 1)

<!--
status: ACTIVE
last_verified: 2026-08-16
-->

Tailscale is reachability infrastructure. It is not part of ADR-010.

## Threat statement

`turn.submit` is an RCE-class privileged control channel. It is not a raw shell primitive, but a compromised caller can cause ChatEngine to perform filesystem, shell, and tool actions when policy allows them or if approval boundaries fail.

## Trust boundaries

1. Tailnet membership (operator-managed). NOT_VERIFIED in this session.
2. Tailscale ACL/grant/policy (operator-managed). NOT_VERIFIED.
3. Tailscale/device identity (optional; not consumed by Babel). NOT_VERIFIED.
4. Babel application authentication: HMAC bearer token in `~/.babel/bridge.json`. VERIFIED by unit tests (missing/invalid token → 401; unauthenticated WS upgrade rejected).
5. Babel ChatEngine policy / execution profile inherited from the thread descriptor. PARTIALLY_VERIFIED (factory uses `executionProfile: mode`; no live policy-broadening test against a real provider).
6. Operation-bound approvals (local digest hardening). PARTIALLY_VERIFIED — see `BABEL_APPROVAL_BINDING_AUDIT.md`. Remote approval UI is not shipped.

The phone is a view/control surface. The Windows Babel host owns repository, filesystem, ChatEngine, tools, policy, approvals, provider credentials, verifier, and execution.

## Topology (intended)

```
phone
  → tailnet
  → Tailscale Serve HTTPS
  → http://127.0.0.1:<port>
  → BridgeServer + ADR-010
  → ChatEngine
```

Requirements:

- Process listen address is `127.0.0.1` (`BridgeServer.listenHost`). VERIFIED in code + bindGuard tests.
- `assertRemoteListenConfig` refuses `BABEL_BRIDGE_HOST` / `BABEL_REMOTE_LISTEN` non-loopback and refuses `TAILSCALE_FUNNEL` / `BABEL_REMOTE_ALLOW_FUNNEL`. VERIFIED in unit tests.
- Funnel as an actually-running Tailscale process: NOT_VERIFIED (env flag only).
- No `0.0.0.0`. VERIFIED (hardcoded listen host + guard).
- Application auth remains required even on loopback and even if Tailscale identity exists.

Operator must pass `--origin https://<magicdns-or-serve-host>` so the phone Origin is allowlisted. Default allowlist is loopback HTTP origins only. `*` is rejected by `babel remote serve` (not appended).

## Authentication notes

- HTTP: `Authorization: Bearer <token>`.
- WebSocket: query `token=` or Authorization header. Query tokens can leak via logs, Referer, and shell history. Documented risk; spike retains existing bridge behavior.
- `GET /health` is unauthenticated and must not include the token. VERIFIED.
- `GET /ui` is unauthenticated HTML; the operator pastes the token in the page. XSS on that page would steal the token. The HTML is static and contains no secrets. PARTIALLY_VERIFIED (no adversarial HTML test).
- CSRF: browsers send Origin on CORS POSTs. `/rpc` rejects non-allowlisted Origin when the header is present. curl without Origin still works with Bearer. Bearer-in-header is relatively CSRF-resistant; query-token WS is weaker.

## Replay / idempotency

- Optional `command_id`: identical thread+id+message hash replays the prior `turn.submit` result. Different message with the same id is rejected. VERIFIED (gateway test).
- Active turn: second `turn.submit` without completing/cancelling returns `TURN_IN_PROGRESS`. Pre-existing host behavior, exercised indirectly.
- This is not cryptographic request signing. A stolen token can submit new `command_id`s.

## Payload limits

- RPC body cap 2 MiB. VERIFIED (413).
- `project_root` must resolve inside the registered workspace root. VERIFIED (path traversal test). This is API authorization, not a sandbox: child processes can still escape.

## Remote authority invariant (D11)

A remotely submitted turn MUST receive the same or a stricter policy envelope than a local ChatEngine turn.

Stage 1 does not add: shell API, raw filesystem-write endpoint, raw shell endpoint, provider-key handling, MCP authority expansion, `ALLOW_SESSION` for remote, session-wide capability grants via the remote UI.

Default `engineFactory` constructs ChatEngine with `executionProfile` from descriptor mode (`chat`/`plan`/`deep`) and `hardPlanMode` for plan. It does not switch to a looser profile because the caller is remote. PARTIALLY_VERIFIED (constructor args in tests; no live tool-policy matrix).

## Public exposure prohibition

Remote mode must refuse to start if configuration would bind a public address or enable Funnel via env. VERIFIED for env/host strings.

Internet-public exposure of a running Tailscale Serve/Funnel deployment: NOT_VERIFIED (no live Tailscale in this session).

## Adversarial tests

| Case | Result | Evidence |
|---|---|---|
| Missing auth | 401 | VERIFIED protocolGateway + sessionServer tests |
| Bad auth | 401 | VERIFIED sessionServer tests |
| Replayed command_id same payload | prior result | VERIFIED |
| Replayed command_id mutated payload | error | VERIFIED |
| Unauthorized WebSocket | 401 | VERIFIED sessionServer tests |
| Stale thread | THREAD_NOT_FOUND | host behavior; PARTIALLY_VERIFIED (existing contract tests) |
| Oversized payload | 413 | VERIFIED |
| Malformed JSON | parse error | PARTIALLY_VERIFIED (dispatch parse path) |
| Binary/null contamination | not dedicated | NOT_VERIFIED |
| Interrupted connection | cancel + reconnect design | PARTIALLY_VERIFIED (cancel test; no socket-drop test) |
| Multiple concurrent phone connections | process-global notification fan-out | DEFERRED (documented risk: all WS get all turn.event) |
| Unexpected public bind | PublicBindError | VERIFIED unit |
| Malformed workspace / traversal | rejected | VERIFIED |
| Origin not allowlisted | 403 | VERIFIED |

## Secrets

Do not put provider keys or the bridge token into `turn.event` logs. Health handler does not echo the token. Error responses use generic messages for workspace rejection. Residual risk: ChatEngine events may include tool stdout; that is pre-existing local behavior, not a new remote API.
