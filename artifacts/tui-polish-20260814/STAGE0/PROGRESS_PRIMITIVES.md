# Progress primitives

## How long-running work composes today

Default chat (`ConversationalRenderer` in `waterfall.ts`):

1. `start()` registers a `FrameScheduler` component (`waterfall-hud` / thinking spinner).
2. While `_state === 'thinking'` and no pending tool lines, `_tick()` (`waterfall.ts:1512`) advances a spinner and calls `_writeThinkingLine()`.
3. `_writeThinkingLine()` (`:1529`) paints `formatConversationThinkingStatus` (liveness + stall) then optionally `renderBackgroundTaskOverlay()` and `renderSubAgentOverlay()`, using `\r\x1b[K` and cursor-up to refresh in place. Tick is **skipped** when `_pendingToolCallLines > 0` so tool rows are not erased.
4. After first answer chunk, thinking HUD stops. Tool groups collapse via `toolPresentation`.
5. `classifyLiveActivity` / `formatLiveActivity` are **not** on this path.

So the user currently sees: spinner + `Thinking… [phase]` + `(Ns · model idle Ns)`, plus optional overlay rows. There is no single `● Editing` line in production chat. That is the #82 attachment: wire `formatLiveActivity` into the existing thinking/tool tick **without** a fourth scheduler.

## Primitive detail

### FrameScheduler — LIVE

`ui/frameScheduler.ts:65` singleton. Waterfall, spinner, prompt cursor, screen manager, thinking state, dialog, focus tracker. Do not create another scheduler.

### ConversationLivenessTracker + formatConversationThinkingStatus — LIVE

`ui/conversationLiveness.ts:13,40`. Stall > 3s shifts dim → warning (`:49-54`). Capture `thinking-stalled.color.plain.txt`:

```text
◐ Thinking… [investigate]  (12s · model idle 4s)
```

Answers “alive?” and “stalled?”. Does not name the current tool.

### classifyLiveActivity — LIVE module, default-chat UNWIRED

`ui/liveActivity.ts:31-53`. Fallthrough:

```ts
if (tool || type) {
  return 'shell';
}
```

Capture `live-activity.color.plain.txt`:

```text
{"tool":"mystery_plugin","type":"custom_unknown"} => shell
● Running
{"type":"frobnicate"} => shell
● Running
```

**#82 (or earlier if painted):** unknown must fail **neutral** (`null` or new `unknown` kind labeled `Working`/`…`, never confident `Running`). Known tools already map to Inspecting / Editing / Running / Verifying.

`recordLiveActivity` holds last line; only tests + `tuiDailyDriverCert.ts` call it.

### Background tasks — LIVE

`toTaskState` (`backgroundTaskProgress.ts:44`) sets `%` only when `task.progress.total > 0`. Footer (`:144-154`) shows `45% 567/1234` or `...` indeterminate. Denominator is real. Overlay returns `null` when no running tasks (`backgroundTaskOverlay.ts:27`).

Accent used for running spinner/bar — identity-as-activity, not success. Failed uses `error`. Completed uses `success` ✓.

### Subagent overlay — LIVE

`renderSubAgentOverlay` (`subAgentOverlay.ts:18`) used from waterfall. Failed = `error('✗ label')`. Complete = **dim** `✓` (not success green). Running = spinner + label + elapsed. Max 5 + “more”. No percentage.

### AgentTeamOverview — TEST_ONLY (not default chat)

`agentProgress.ts:264-267`:

```ts
const doneCount = complete + failed;
const progressPct = total > 0 ? doneCount / total : 0;
const progressBar = success('█'.repeat(filled)) + ...
```

All-failed team → success-colored 100% bar. **Do not promote this surface.** If #82 never touches the file, leave it. If touched, rename metric to settled/finished and stop painting the bar `success` when `failed > 0`.

## Percentages — policy

| Surface | Has real denominator? | Label accurate? | Default chat? |
|---------|----------------------|-----------------|---------------|
| token compact bar | yes, model context limit; unknown → `ctx ?` | `%` of **active** context when `hasExplicitActiveContext` | yes |
| bg-task footer | only if `total > 0` | current/total | yes if tasks exist |
| AgentTeamOverview | agent count | **no** — includes failures as “done”, painted success | **no** |
| live activity | none | must not invent | #82 |

Do not invent percentages. Do not create another activity ontology — extend `LiveActivityKind` with a neutral unknown if needed, or return `null` and let the thinking line stay `Thinking…`.
