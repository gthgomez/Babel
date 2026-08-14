# State-Duplication Archaeology & Canonical Event Mapping

## Objective
Map all sources of truth, cached copies, mutation points, and rendering consumers across Babel's chat lifecycle to eliminate state divergence bugs.

---

## 1. State Topology Matrix

| Concept | Canonical Source of Truth | Secondary Copies | Mutation Sites | Rendering Consumers | Risk / Invariant |
|---|---|---|---|---|---|
| **Terminal Outcome** | `ChatResult.outcome` / `evaluateCompletionGate` | `ReplContext.state.lastRunUserStatus`, `ctx.lastAssistantStatus` | `chatEngine.ts:5017`, `chat.ts:192` | `reviewCard.ts`, `statusBar.ts`, `transcriptCell.ts` | Cannot claim verified without authoritative green receipt. |
| **Active Model** | `modelRouter.ts` / `options.model` | `ReplContext.state.model`, `statusBar.ts:state.model` | `/model` command, `chatEngine.ts:4290` | Status bar, token bar denominator | Denominator must update atomically with active model switch. |
| **Active Request Context** | `ChatResult.activeContext` (`prompt_tokens`) | `ctx.lastTurnActiveContextTokens`, `statusBarState.activeContext` | `chatEngine.ts:4289`, `chat.ts:195` | `statusBar.ts` context meter (`[ctx 25%]`) | Helper models (critic, reviewer) must NOT overwrite conversation model context meter. |
| **Session Cumulative Tokens** | `globalCostTracker.getSessionSummary()` | `ctx.state.costTotals.totalTokens` | `trackRunnerUsage` in `chatEngine.ts:4291` | `statusBar.ts` total tokens | Kept distinct from per-turn request context. |
| **Verification State** | `ChatResult.verifierReceipt` / `executedVerifierLedger` | `ctx.turns[i].verifierReceipt`, `reviewCard.ts` | `executeVerifierKernel`, `toExecutorVerifierReceipt` | Review card badge, transcript summary | Verification failure must project as unverified / failed. |
| **Tool Call Lifecycle** | `ChatEngine.toolCallLog` | `turn.toolCalls`, `events: tool_start/tool_end` | `runTool`, `applyToolEffects` | Tool progress spinners, transcript cells | Start must precede progress and completion (1:1 matching). |
| **Changed Files** | `mutationPathsFromSessionEvents` | `turn.toolCalls[].target` | Mutation tools (`write_file`, `str_replace`, `apply_patch`) | Review card diff preview, git status indicator | Read-only tasks must project 0 mutations and no patch preview. |
| **Cancellation** | `AbortController.signal.aborted` | `ctx.state.lastRunUserStatus = 'cancelled'` | `handleInteractiveInterrupt`, `engine.abortTurn()` | `renderCancellationCard`, status bar | Cancelled turns must not emit done events or stale final answers. |

---

## 2. Canonical Projection Architecture

```
                                 ┌───────────────────────────────┐
                                 │   Canonical Event Stream     │
                                 │ (turn_start, tool_*, done...) │
                                 └──────────────┬────────────────┘
                                                │
                                  Pure Projection Reducer
                                                │
                 ┌──────────────────────────────┼──────────────────────────────┐
                 ▼                              ▼                              ▼
     ┌──────────────────────┐       ┌──────────────────────┐       ┌──────────────────────┐
     │   StatusBarState     │       │   ReviewCardState    │       │   TranscriptState    │
     │  (model, ctx, cost)  │       │ (outcome, verifier)  │       │  (turns, tool trace) │
     └──────────────────────┘       └──────────────────────┘       └──────────────────────┘
```
