# Babel Remote evidence ledger

Status: living document for the remote implementation campaign. **Qualified** means owner-only live setup; **Tested** means deterministic automated proof in CI or local `tsx --test`.

## Command Code own-CLI acceptance matrix (PR #397 bounded batch)

Published review head at matrix update: `9a6a591ee9c1ebb8763c228515d7c8d8bf17f9ed` (prior independent delta). Local proof batch after delta reconciliation: unpublished until next push. Gate `39263205398` on `9a6a591e`: **architecture-regressions failed** on published head (ubuntu/windows); other jobs still in flight at matrix edit — **not certified complete**.

| # | Invariant | Production entrypoint / source | Exact regression assertion | Failing-before evidence | Current command / exit / result | Remaining limitation |
|---|-----------|------------------------------|----------------------------|-------------------------|--------------------------------|----------------------|
| 1 | `harness.command_code.open` lease + canonical binding; denials skip `openSavedSession`; active turn / cross-root / cross-thread native owner | `protocolGateway.dispatchCommandCodeOpen`, `remoteCatalog.findCanonicalCommandCodeNativeOwnerForProject` | `commandCodeOpenSideEffects.gateway.test.ts` (6 cases): stale epoch, native mismatch, `project_root`, active turn, cross-thread native; zero `openSavedSession` on deny | Delta review `9a6a591e`: in-memory-only owner scan; open during load race | `node --import tsx --test src/bridge/commandCodeOpenSideEffects.gateway.test.ts` → **exit 0**, 6/6 | Live installed `cmdc` qualification still deferred |
| 2 | `session/load` always; init serialized; cold catalog + durable owner index project-scoped | `commandCodeAcpRuntime.ensureSession` (`sessionInit`), `remoteCatalog.indexCommandCodeNativeOwners(root)` | `serializes concurrent ensureSession while session/load is in flight`; `lists bound vendor session from durable owner after runtime eviction`; replay no-`messageId` merge + tool boundary split | Probes: second `ensureSession` during held load returned `replayCapture=true`; list-order owner | `commandCodeOwnCli.gateway.test.ts` → **exit 0**, 15/15; `commandCodeAcpReplay.test.ts` → **exit 0**, 3/3 | `persistReplayHistory` still skips existing cell ids without payload refresh; `listSessions` throws `COMMAND_CODE_SESSION_LIST_INCOMPLETE` after 20 pages (not gateway-tested) |
| 3 | PWA catalog picker → open/history → reconnect → continue same native | `remote-ui/app.js` (`control.acquire` before paired open), cold catalog vendor merge | `e2e/commandCodePwaVendorOpen.gateway.test.ts` + `commandCodePwaVendorOpen.browser.js` (catalog wait, reconnect, `fixture:continue-same-native`) | Injected `<option>`; no WS continue leg | `node --import tsx --test src/bridge/e2e/commandCodePwaVendorOpen.gateway.test.ts` → **exit 0**, 1/1 | Physical phone / live provider journey deferred; paired-device PWA not separately e2e'd (host-bearer journey covered) |
| 4 | `session/list` cursor; USD delta with known baseline; incomplete list fail-closed; tool failure mapping | `commandCodeAcpRuntime.listSessions`, `commandCodeAcpEventMap` | Gateway pagination; event-map USD delta, unknown baseline partial, EUR unknown, `tool_failed` | EUR baseline poisoned USD; silent 20-page truncation; zero baseline after load | Event-map + gateway pagination → **exit 0** | Non-USD turn costs remain incomplete by design |
| 5 | Post-admission cancel oracle; immediate next prompt; dedicated server cleanup | `command-code-acp-peer.mjs`, gateway tests | `does not fabricate cancelled…`; `cancels a slow turn…`; `withDedicatedServer` try/finally | Windows `39252099671` fabricated cancel + EBUSY | `commandCodeOwnCli.gateway.test.ts` → **exit 0** | 200ms observation window on no-fabricated-cancel test |
| 6 | Registry shutdown on bridge stop | `BridgeServer.stop` → `commandCodeRegistry.closeAll` | Dedicated paths use `withDedicatedServer` | EBUSY leak on assertion-before-stop | Gateway suite **exit 0** | — |
| 7 | Prior-head Public Release Gate fail-closed; malformed `gh` cannot fake first publication | `tools/assert-branch-prior-gate-complete.mjs` | `assert-branch-prior-gate-complete.test.mjs` (8 cases) incl. malformed `workflow_runs` | `{}` gh payload granted first-publication bypass | `node --test tools/assert-branch-prior-gate-complete.test.mjs` → **exit 0**, 8/8 | Push guard not re-run on unpublished batch |

### Prior canonical closures (regression rows — do not rewrite)

| Invariant | Source | Assertion | Status |
|-----------|--------|-----------|--------|
| v1 prompt `stopReason` terminal; startup idle ignored | `commandCodeAcpEventMap`, gateway | `commandCodeAcpEventMap.test.ts`, `ignores session/new startup idle…` | Regression kept |
| Permission edit SHA256 / unknown kind null | `commandCodeAcpPermission.ts` | `commandCodeAcpPermission.test.ts` | Regression kept |
| Replay stable ids with explicit `messageId` | `commandCodeAcpReplay.ts` | `merges chunks with the same messageId…` | Regression kept |

## Milestone table (remote campaign)

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
| 2 | Desktop ↔ phone single owner | Not qualified | Production IPC + `remote host-run` path in progress; phone E2E pending |
| 6 | Command Code own-CLI ACP adapter (managed subprocess) | Tested (strict canonical ACP v1 peer) | Matrix above + `commandCodeAcpPermission.test.ts`; **not** live installed `cmd`/`cmdc` qualification |
| 6 | Other external harness adapters (OpenCode, AGY, Claude, Codex) | Stub only | `harnessAdapterRegistry.ts` campaign stubs |
| — | Physical phone + Tailscale | Not qualified | Owner checklist in `BABEL_REMOTE_QUICKSTART.md` |

**Owner deferred after merge:** physical ROG14/phone remote journey; live Command Code login/provider on host; Windows `cmdc` path smoke against installed binary.
