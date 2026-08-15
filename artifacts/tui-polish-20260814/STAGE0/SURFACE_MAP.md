# Surface map

Classification is from **call sites**, not comments. Paths are under `babel-cli/src/`.

| Surface | Source | Live symbols | Semantic purpose | Styling path | Width behavior | Truthfulness risk | Terminal risk | Batch |
|---------|--------|--------------|------------------|--------------|----------------|-------------------|---------------|-------|
| Semantic theme helpers | `ui/theme.ts` | `success`, `error`, `warning`, `muted`, `ghost`, `info`, `accent*` , `colorToken`, `supportsColor` | Daily-driver paint | `COLOR_TOKENS` + module-load `HAS_COLOR`/`HAS_TRUE` | n/a | Color reused across meanings | Low | #80 |
| ThemeProvider | `ui/theme.ts:420` | `ThemeProvider` | Unused wrapper for runtime theme switch | `colorToken` | n/a | Misleading comment claims components call it | None | #80 comments only |
| Tokens / themes | `ui/tokens.ts` | `babelDusk`, `babelDawn`, daltonized variants, `COLOR_TOKENS`, `setActiveTheme` | Theme tables | hex + 256 fallbacks | n/a | Daltonized success is blue — icon still required | None | #80 |
| Status bar | `ui/statusBar.ts:73` | `renderStatusBar`, `StatusBarState` | Persistent metadata | `bgPanel` + muted/info/warning | Build-all then truncate left | Session `totalTokens` sit next to active ctx `%` | Wrap if truncate math fails | #81 |
| Token bar | `ui/tokenBar.ts` | `renderTokenBar`, `renderCompactTokenBar`, `classifyUtilization`, `getContextLimit` | Active-context meter | `muted/info/warning/error` by tier | Compact `[bar %]` | Unknown limit → `ctx ?` (good). Critical uses `error` | Low | #80/#81 |
| Review card | `ui/reviewCard.ts` | `classifyReviewCard`, `buildReviewCard`, `presentChatReview`, `getContextualNextActions` | Authoritative turn outcome | success/warning/error/muted + glyph | Unbounded vertical | Read-only `NO_CHANGE` painted `success('✓ Complete')` | Low | #80/#83 |
| Tool presentation | `ui/toolPresentation.ts` | `groupToolExecutions`, `formatToolGroupSummary`, `renderToolExecutionTrail` | Collapsed routine / expanded fail | ✔ success / ✖ error / ○ muted unverified | Fitted at 60–160 | Absence of exit ≠ success (`unknown`) | Low | #80 |
| Waterfall / conversational | `ui/waterfall.ts` | `ConversationalRenderer`, `_tick`, `_writeThinkingLine` | Default chat transcript + thinking HUD | theme helpers + raw CSI `\r\x1b[K` | Reflow on resize | Thinking line can sit above overlays | **High** (erase, cursor, resize) | #82 |
| Liveness | `ui/conversationLiveness.ts` | `ConversationLivenessTracker`, `formatConversationThinkingStatus` | Alive? + stall | dim → warning after 3s idle | Single line | Stall uses warning (attention, not failure) | Medium | #82 |
| Live activity | `ui/liveActivity.ts` | `classifyLiveActivity`, `formatLiveActivity`, `recordLiveActivity` | Calm current-activity line | plain `● Label` (no color) | 1–5 lines | **Unknown tool/type → `shell` / `Running`** | Low until wired | #82 (fix earlier if #80 paints it) |
| FrameScheduler | `ui/frameScheduler.ts:65` | `FrameScheduler.getInstance` | Unified tick | n/a | n/a | n/a | **High** | reuse; do not replace |
| Background footer | `ui/backgroundTaskProgress.ts:133` | `renderBackgroundTaskFooter`, `toTaskState` | Status-bar bg tasks | accent spinner, success/error marks | Truncate to allotment | `%` only when `total > 0` | Medium | #81/#82 |
| Background overlay | `ui/backgroundTaskOverlay.ts:24` | `renderBackgroundTaskOverlay` | Expanded panel during thinking | via progress renderer | Compact if >3 tasks | Empty → `null` | Medium | #82 |
| Subagent overlay | `ui/subAgentOverlay.ts:18` | `renderSubAgentOverlay` | Running/failed/done kids | dim + `error` on fail | Max 5 | Complete uses dim `✓` not success green | Medium | #82 |
| Agent team overview | `ui/agentProgress.ts:158` | `AgentTeamOverview` | Multi-agent dashboard | success bar includes failures | Box chrome | `doneCount = complete + failed` then **success-colored 100%** | Low (not default chat) | do not expand |
| Highlight | `ui/highlight.ts` | `highlightLine`, markdown ANSI | Code/markdown | **raw** `\x1b[32m` etc. + some theme helpers | wrap | Syntax green ≠ outcome success | Low | #80 justify |
| History cells | `ui/historyCells/*` | `cells.ts` user prefix | Transcript cells | `accentBright` user label | layout.ts | Identity accent on user chrome (OK) | Low | #80 light |
| Renderers / sections | `ui/renderers.ts`, `ui/sections.ts` | header/status badges | Deep/plan chrome | `accentBright('BABEL')`, `accentBright('BLOCKED')` | truncate | Accent used as status | Low | #80 |
| Dialog / picker | `ui/dialog.ts`, `ui/themePicker.ts` | dialogs | Non-default overlays | mixed helpers + raw `\x1b[32m✓` | width-aware | Raw green check | Medium | #80 if on path |
| A11y | `ui/a11y.ts` | `isA11yMode`, `sanitizeForA11y` | `BABEL_A11Y=1` linear mode | strips all ANSI | n/a | `NO_COLOR` ≠ a11y (documented, correct) | Low | preserve |
| Token history / charts / panes | `tokenHistory.ts`, `usageCharts.ts`, `paneManager.ts` | optional advanced | Forensic / pane | various | n/a | Dashboard temptation | Medium | **do not expand** |

## Named primitive classifications

| Symbol | Status | Proving call sites (production unless noted) |
|--------|--------|-----------------------------------------------|
| `ThemeProvider` | **UNUSED** | Defined `ui/theme.ts:420`. Repo-wide `ThemeProvider` grep hits only that file. Zero `getInstance()` / `new ThemeProvider` consumers including tests. |
| `FrameScheduler` | **LIVE** | `waterfall.ts` schedule/tick; `spinner.ts`; `promptInput.ts`; `screenManager.ts`; `thinkingState.ts`; `dialog.ts`; `focusTracker.ts`; `latencyAdapter.ts`; `outputBuffer`/`frameStats` observers. |
| `classifyLiveActivity` | **LIVE module, UNWIRED in default chat** | Defined `liveActivity.ts:31`. Production consumer: `tuiDailyDriverCert.ts:20,115,433` (cert harness). Waterfall does **not** call it. Tests: `liveActivity.test.ts`. |
| `ConversationLivenessTracker` | **LIVE** | Constructed `waterfall.ts:1354`; `formatConversationThinkingStatus` used `waterfall.ts:1533`. |
| `renderBackgroundTaskFooter` | **LIVE** | `statusBar.ts:14,80`. |
| `renderBackgroundTaskOverlay` | **LIVE** | `waterfall.ts:33,1543`. |
| `renderSubAgentOverlay` | **LIVE** | `waterfall.ts:67,1551`. |
| `AgentTeamOverview` | **TEST_ONLY** | Defined `agentProgress.ts:158`. Instantiated only in `integration-snapshot.test.ts`. No default-chat import. |

## Default-chat composition today

```text
ConversationalRenderer
  ├─ thinking: FrameScheduler tick → formatConversationThinkingStatus
  │            + renderBackgroundTaskOverlay + renderSubAgentOverlay
  │            (erase via \r\x1b[K; skip tick when tool lines pending)
  ├─ tools: toolPresentation collapse / expand
  ├─ assistant: markdown accumulator
  └─ between turns: renderStatusBar (session meta + compact token bar)
turn end: presentChatReview / buildReviewCard
NOT composed: ThemeProvider, classifyLiveActivity, AgentTeamOverview,
              usageCharts, themePicker, token-history sparkline
```
