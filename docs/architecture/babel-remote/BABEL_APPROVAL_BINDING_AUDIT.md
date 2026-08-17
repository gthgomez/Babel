# Babel Approval Binding Audit

<!--
status: ACTIVE
last_verified: 2026-08-17
-->

Remote V1 now exposes `ALLOW_ONCE` / `DENY` via `approval.decide` bound to the existing operation digest. Remote UI cannot create `ALLOW_SESSION`. Chat MCP remains a local TUI bypass; **remote** MCP is fail-closed (`AUTOMATED_VERIFIED`). Phone approval UX is `NOT_VERIFIED`.

## Ledger (current code)

| ACTION TYPE | CURRENT APPROVAL IDENTITY | PAYLOAD BOUND? | TARGET BOUND? | CWD BOUND? | SESSION/TURN BOUND? | CAN IT MUTATE AFTER APPROVAL? | CAN SESSION ALLOW OVER-GRANT? | SEVERITY |
|---|---|---|---|---|---|---|---|---|
| run_command | command string + capability inference; chatApproval proposed_scope now includes full command plus payload field `nopayload` | command text in digest | n/a (cwd in digest) | yes (digest `canonical_cwd`) | thread_id + turn_id in digest | same-turn mutation denied if digest wired | allow_session stores scope-key only (not bare capability). Default `buildApprovalRequest` scope is still first-token coarse if caller omits proposed_scope | MEDIUM |
| write_file | historically `write ${path}` / first-token scope `write:write` | **was NO**; **now YES** via `payload_sha256` in `approvalOperationFromAgentAction` when chatApproval path is used | path in digest + proposed_scope | yes | thread+turn in digest | same-turn: dialog→execute digest mismatch denies. Cross-turn: proposed_scope includes payload hash so different content is a new scope | **CONFIRMED historical over-grant** via bare capability (removed) and coarse default proposed_scope | HIGH (historical), MEDIUM residual |
| apply_patch | historically generic `apply_patch` | **was NO**; **now YES** via patch body sha256 on chatApproval path | no path (patch may touch many files) | yes | thread+turn | same-turn digest deny | generic command name remains if caller uses default proposed_scope | HIGH (historical) |
| MCP (chat) | `requestMcpApproval` can digest server + query json; **ChatEngine does not call it** | helper YES for `query`; live path **NO** | server name | cwd in helper | helper only | live path executes without approval | n/a on live chat MCP | **HIGH — CONFIRMED bypass** |
| MCP (pipeline JIT) | fingerprints used for denials (pre-existing; not re-audited line-by-line this session) | PARTIALLY_VERIFIED | PARTIALLY_VERIFIED | ? | ? | ? | ? | UNKNOWN pending dedicated pipeline audit |
| allow_session | previously added **bare capability** to `sessionAllows` | n/a | n/a | n/a | session-wide | yes — any later action of that capability | **CONFIRMED over-grant**; `applyApprovalDecision` now adds `capability::proposed_scope` only; `isPreApproved` no longer treats bare capability as allow | HIGH (historical), LOW if callers pass tight proposed_scope |

## Confirmed vs deferred

CONFIRMED (code, this session):

- `allow_session` used to `sessionAllows.add(capability)`. Removed. Regression test injects bare `'write'` and expects no pre-approval.
- write_file / apply_patch identities were path/generic without content/patch body. Digest helpers now hash content/patch.
- Chat MCP executes without `requestMcpApproval` (`chatEngine.ts` comment: “MCP calls execute without approval prompts in chat mode”).

DEFERRED:

- Wiring `requestMcpApproval` into ChatEngine (would change local chat UX; out of Stage 1 remote UI, and D11 allows stricter but this is a local behavior change).
- `session_epoch` in the digest.
- Canonical argv arrays vs raw command strings.
- apply_patch file-list binding (body hash only).
- MCP arguments beyond `query`.
- Remote `ALLOW_ONCE` UI.
- Cryptographic binding of the approval dialog target widget to the digest (UI still shows path/command text).

## Operation digest (implemented)

`babel-cli/src/agent/approvalOperation.ts`

Canonical fields: `thread_id`, `turn_id`, `action_type`, `canonical_cwd`, plus command / target_path / payload_sha256 / mcp_server / mcp_tool / mcp_arguments_sha256 when present.

`operation_digest = SHA256(stableJson(canonical fields))`.

Invariant on the chatApproval path: recompute from the live action before execute; mismatch → deny (interactive) or deny (headless). If a session pre-approval scope no longer matches the live digest, chatApproval **falls through to a new prompt** instead of silent-deny for the interactive pre-approved case; headless mismatch denies.

Tests: `babel-cli/src/agent/approvalOperation.test.ts` plus existing `harnessParityP1P3` scoped-approval tests.

## Remote V1 rule

Only `ALLOW_ONCE` will be offered on the phone, and only after Stage 2. `ALLOW_SESSION` stays forbidden for Remote V1 even though the local TUI can still set `BABEL_APPROVAL_SESSION=1`.
