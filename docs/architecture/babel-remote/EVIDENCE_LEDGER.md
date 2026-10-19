# Babel Remote evidence ledger

Status: living document for the remote implementation campaign. **Qualified** means owner-only live setup; **Tested** means deterministic automated proof in CI or local `tsx --test`.

## Command Code own-CLI acceptance matrix (PR #397 bounded batch)

Published review head at matrix authoring: `05c242a018ea20981b849112300be4a1d09ae311`. Local proof batch: `b37fc0dc` + matrix/tests commits (unpublished until next push). Gate `39259763900` on `05c242a0`: **completed success** (observed after local work).

| # | Invariant | Production entrypoint / source | Exact regression assertion | Failing-before evidence | Current command / exit / result | Remaining limitation |
|---|-----------|------------------------------|----------------------------|-------------------------|--------------------------------|----------------------|
| 1 | `harness.command_code.open` requires valid control epoch and canonical `thread_id` + native/workspace binding; denials must not call `openSavedSession` | `protocolGateway.dispatchCommandCodeOpen`, `REMOTE_MUTATING_RPC_METHODS` | `commandCodeOpenSideEffects.gateway.test.ts`: `denies open with stale control_epoch…` (`openSavedSessionCalls` unchanged); `rejects mismatched native id…` (calls unchanged). `commandCodeOwnCli.gateway.test.ts`: `rejects harness.command_code.open when native id does not match` | Independent probe on `05c242a0`: open before lease + identity overwrite (`/workspace/shared/pr397-05c-review/` cited in review) | `node --import tsx --test src/bridge/commandCodeOpenSideEffects.gateway.test.ts` → **exit 0**, 2/2 | No automated case yet for `TURN_IN_PROGRESS` during open, cross-thread native owner, or `project_root` mismatch (handler exists) |
| 2 | Fresh runtime always `session/load`; replay deduped separately; cold catalog owner from durable descriptors | `commandCodeAcpRuntime.ensureSession`, `remoteCatalog.indexCommandCodeNativeOwners` | `reloads saved session after project runtime eviction`; `paginates vendor sessions using official session/list cursor`; `commandCodeAcpReplay.test.ts` no-`messageId` chunk merge | Probe: `hasPersistedReplay` skipped `session/load` on `05c242a0` | `node --import tsx --test src/bridge/commandCodeOwnCli.gateway.test.ts` → **exit 0**, 13/13; replay unit → **exit 0**, 2/2 | `persistReplayHistory` still skips existing cell ids without payload refresh; cursor-repeat guard untested at gateway level |
| 3 | PWA vendor picker → open → inspect history before prompt → resume canonical thread | `remote-ui/app.js` `createThread`, `harness.command_code.open` | `e2e/commandCodePwaVendorOpen.gateway.test.ts`: RPC precheck `history.lookup` ≥2 cells + DOM leg `runCommandCodePwaVendorOpenDomLeg` (`fixture:history-replay` in `#transcript`, `resumedSameThread`) | Prior batch: repeated open twice in same registry only; no DOM journey | `node --import tsx --test src/bridge/e2e/commandCodePwaVendorOpen.gateway.test.ts` → **exit 0**, 1/1 | **OPEN:** no browser `turn.submit` continue/reconnect leg after open; catalog refresh without manual `<option>` inject not asserted |
| 4 | Official `session/list` `cursor`; cumulative USD deltas; live tool failure mapping | `commandCodeAcpRuntime.listSessions`, `commandCodeAcpEventMap` | Gateway pagination test; `commandCodeAcpEventMap.test.ts` cumulative delta + `tool_failed`; fixture `handleSessionList` uses `params.cursor` | Probe: `nextCursor` request loop; per-turn USD 0.10/0.15; failed tool → `tool_complete` on `05c242a0` | Event-map/replay units + gateway pagination → **exit 0** | Non-USD still `unknownChargeCount`; EUR path owner-deferred |
| 5 | Post-admission cancel oracle; immediate next prompt without stale coroutine text; pre-admission cancel without prompt admitted | `command-code-acp-peer.mjs`, gateway tests | `does not fabricate cancelled…` (`fixture:prompt-admitted` barrier); `preserves pending cancel through session startup…`; `cancels a slow turn…` (50ms gap, no `slow-cancel` in next answer); fixture prompt id checks after slow path | Windows job `118059172870`: fabricated `cancelled` + EBUSY; fixture cross-turn leak cited in protocol review | `commandCodeOwnCli.gateway.test.ts` → **exit 0**, includes rows above | 700ms observation on no-fabricated-cancel test remains (not interleaved immediate submit) |
| 6 | Dedicated ACP children stopped on test failure; production shutdown closes registry | `withDedicatedServer` try/finally; `BridgeServer.stop` → `commandCodeRegistry.closeAll` | All dedicated paths in `commandCodeOwnCli.gateway.test.ts` use `withDedicatedServer`; suite `after` stops main server | Prior failure: assertion before `slowServer.stop()` → EBUSY (`39252099671` Windows2) | Gateway suite **exit 0** (13 tests) | No separate production shutdown integration test in this batch |
| 7 | Designated prior-head Public Release Gate fail-closed; first-publication exception only | `tools/assert-branch-prior-gate-complete.mjs` | `assert-branch-prior-gate-complete.test.mjs` (7 cases): empty matching gate + `branchHasAnyGateRuns: true` → deny; `branchHasAnyGateRuns: false` → allow | `evaluatePublishedHeadGate([], 'abc')` → allow:true on `05c242a0` guard | `node --test tools/assert-branch-prior-gate-complete.test.mjs` → **exit 0**, 7/7 | Push guard on unpublished local batch not re-run here; pagination capped at 5×100 runs |

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
