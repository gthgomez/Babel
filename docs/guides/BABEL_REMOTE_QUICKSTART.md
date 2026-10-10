# Babel Remote — Quick start

<!-- status: ACTIVE -->

Babel Remote is the installable supervisory PWA served by `babel remote serve` on loopback (`127.0.0.1`). Reach it from a phone or browser on your tailnet with **Tailscale Serve** (not Funnel).

## Enable on the host

1. From your workspace: `babel remote serve --project <workspace-root>`
2. Note the health URL and UI URL printed by the CLI.
3. Expose loopback privately: `tailscale serve --bg <port>`
4. Add your Serve HTTPS origin: `babel remote serve --origin https://<your-machine>.<tailnet>.ts.net`

## Pair a device (cookie session)

1. On the host (Desktop or CLI with bearer token): `POST /pair/challenge` → QR / link with `challenge_id`.
2. On the phone: open `/pair?challenge_id=…`, submit a device label (`POST /pair/request`).
3. On the host: approve with `POST /pair/approve` (bearer required).
4. On the phone: poll `GET /pair/status?challenge_id=…` until `paired`; the host sets an HttpOnly `babel_remote_session` cookie.

Revoke devices with `DELETE /pair/devices/<deviceId>` (bearer required).

## Start or attach to a session

1. Create a transport session: `POST /sessions` with `{ "projectRoot": "…" }`.
2. Create or resume a thread with **`session_id`** set to that transport session id (required for WebSocket tickets).
3. Mint `POST /ws/ticket` with `{ session_id, thread_id }`, then open `WS /ws?sessionId=…&ticket=…`.
4. List host sessions: JSON-RPC `remote.catalog`.

## Verification status (this repository)

| Capability | Status |
|---|---|
| PWA + ADR-010 gateway | Implemented; gateway + browser integration tests |
| `session_id` thread binding | Implemented |
| Device pairing (cookie) | Implemented; not physically verified on Android |
| Desktop unified live session | Partial — `remoteHost.mjs` + shared `HttpProtocolClient`; Desktop UI still launches CLI child by default |
| Background host lifecycle | Partial — `babel remote serve` is the host; no Windows service yet |
| Physical Android | **NOT VERIFIED** — use browser at 390px width as emulation only |
