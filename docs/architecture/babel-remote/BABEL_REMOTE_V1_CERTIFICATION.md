# Babel Remote V1 — Certification ledger

<!--
status: ACTIVE
last_verified: 2026-08-17
-->

Evidence classes used here:

`IMPLEMENTED` / `AUTOMATED_VERIFIED` / `LIVE_HOST_VERIFIED` / `PHONE_VERIFIED` /
`NOT_VERIFIED` / `BLOCKED_EXTERNAL` / `BASELINE_FAIL` / `FAILED`

Do not promote `NOT_VERIFIED` to `VERIFIED` without machine evidence.

| Capability | Class | Evidence |
|---|---|---|
| ADR-010 path, no second API | `IMPLEMENTED` | `BridgeServer` → `ProtocolGateway` → `handleProtocolRequest` |
| Loopback bind / Funnel refuse | `AUTOMATED_VERIFIED` | `bindGuard.test.ts` |
| App auth required | `AUTOMATED_VERIFIED` | missing/invalid bearer → 401 |
| V1 WS ticket (no long-lived URL bearer) | `AUTOMATED_VERIFIED` | `wsTicket.test.ts`, `/ui/app.js` has `ticket=` and no `token=` |
| Origin reject | `AUTOMATED_VERIFIED` | RPC 403 + WS origin check |
| Thread event isolation | `AUTOMATED_VERIFIED` | `remoteV1.gateway.test.ts` |
| command_id same/changed payload | `AUTOMATED_VERIFIED` | existing gateway + V1 tests |
| 100 KiB UTF-8 integrity | `AUTOMATED_VERIFIED` | gateway integrity tests |
| turn.cancel | `AUTOMATED_VERIFIED` | existing cancel test |
| history / reconnect UNKNOWN | `AUTOMATED_VERIFIED` | `remoteReconnect.test.ts` + history.lookup |
| ALLOW_ONCE / DENY / no session grant | `AUTOMATED_VERIFIED` | `remoteApproval.test.ts` + `approval.decide` |
| Remote MCP fail-closed | `AUTOMATED_VERIFIED` | `remoteMcpIsFailClosed` + `requestMcpApproval` |
| PWA surfaces + safe render + SW exclusions | `AUTOMATED_VERIFIED` | `remoteUiPolicy.test.ts` + `/ui` HTTP |
| verification missing ≠ PASS | `AUTOMATED_VERIFIED` | `verificationMap.test.ts` |
| workspace.changes / diff | `IMPLEMENTED` | Git snapshot method; host-dependent |
| Live provider turn | `NOT_VERIFIED` | run only if credentials exist this session |
| Tailscale Serve / Funnel-as-process | `BLOCKED_EXTERNAL` | not exercised here |
| Android / phone / sleep-wake | `NOT_VERIFIED` | see mission §17 procedure |
| protocol.test.ts notification catalog (2 vs 6) | `BASELINE_FAIL` | pre-existing drift on Stage-1 |

Phone certification procedure remains the mission §17 checklist. Do not mark
`PHONE_VERIFIED` until that procedure is observed on a real device.
