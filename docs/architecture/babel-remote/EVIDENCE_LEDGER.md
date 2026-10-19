# Babel Remote evidence ledger

Status: living document for the remote implementation campaign. **Qualified** means owner-only live setup; **Tested** means deterministic automated proof in CI or local `tsx --test`.

| Milestone | Capability | Status | Proof |
|-----------|------------|--------|-------|
| 3 | Pairing landing `/pair` | Tested | `bridgePairing.integration.test.ts`, `remoteSecurity.gateway.test.ts` |
| 3 | Admin routes host-bearer only | Tested | `bridgePairing.integration.test.ts` |
| 3 | Paired CSRF / Origin on mutations | Tested | `remoteSecurity.gateway.test.ts` |
| 3 | Device session disk persistence | Tested | `devicePairing.test.ts`, `remoteSecurity.gateway.test.ts` |
| 4 | Control lease enforced (no prod bypass) | Tested | Paired clients always lease-gated; `remote.capabilities`; no env bypass |
| 4 | Monotonic epoch fencing | Tested | `controlLease.test.ts`, `remoteSecurity.gateway.test.ts` |
| 4 | WS ticket binds client + lease on WS RPC | Tested | `remoteControlWs.gateway.test.ts`, `wsTicket.test.ts` |
| 4 | Paired force-acquire blocked | Tested | `remoteControlWs.gateway.test.ts`, `remoteSecurity.gateway.test.ts` |
| 5 | PWA lease renewal + foreground resume | Tested | `remote-ui/app.js` (interval + visibility/focus); `controlLease.test.ts` (expiry without renew) |
| 5 | PWA settled RPC rejection vs UNKNOWN | Tested | `remoteUiPolicy.test.ts`, `remote-ui/app.js` submit path |
| 4 | Revoke: no WS fan-out / ticket mint | Tested | `remoteRevokeFanout.gateway.test.ts`, `remoteControlWs.gateway.test.ts`, `sessionServer.ts` |
| 4 | Stale epoch / command_id integrity | Tested | `remoteSecurity.gateway.test.ts`, `protocolGateway.test.ts` |
| 4 | Stale approval digest / replay | Tested | `remoteApproval.test.ts`, `remoteSecurity.gateway.test.ts` |
| 2 | Desktop ↔ phone single owner | Tested (deterministic) | `sharedProtocolHostRun.*`, desktop shared-session/stack tests; phone E2E still not qualified |
| 6 | External harness adapters — Command Code own-CLI slice | Tested (fixture/discovery) | `commandCodeCliDiscovery.test.ts`, `commandCodeOwnCliAdapter.test.ts`, `harnessAdapterRegistry.test.ts`, `remote.capabilities` via `remoteSecurity.gateway.test.ts` |
| 6 | OpenCode / AGY / Claude Code / Codex adapters | Not implemented | Campaign stubs in `harnessAdapterRegistry.ts` (`not-implemented`) |
| 6 | Unmanaged live TUI attach | Unsupported (explicit) | `remote.capabilities.unmanaged_live_attach.supported=false` |
| — | Physical phone + Tailscale | Not qualified | Owner checklist in `BABEL_REMOTE_QUICKSTART.md` |

**Last tested commit:** `ea02842f2be7eb671eac2bc9532f3e3ac0369bd8` (merge #393); adapter slice pending new PR head.
