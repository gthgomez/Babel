# G-L1 live execution ownership

**Agent B only** runs the single authorized general G-L1 diagnostic (`research v2 run` + OpenRouter). **Agent A does not** execute live smoke or spend for this campaign.

Mission: `G-L1-mission.json`. Non-secret preflight: `npm run test:research-v2-campaign-preflight`.

Full readiness pack (command template, logs, prior 268-pass receipt): repository `review-artifacts/G-L1-READINESS-FOR-B.md` and `B_REREVIEW_HANDOFF.md` § G-L1 single live run.

Coordinator issues live command to B after mission/route validation.

**A repair (post B ac011dea failure):** strict output contract for **all four** model ops in `modelOutputContractPrompt.ts` (sync-tested vs Zod in `modelOutputs.contract-prompt.test.ts`); default bridge prompt no longer sends `operation_kind`+`input` only. Malformed replay: `G-L1-live-malformed-plan-questions-response.json`. Failed passes: `terminal_state: failed` (`finalizeFailedOwnerResearchPass.ts`). **Attempt 2** live identity is B-owned; A does not execute live.
