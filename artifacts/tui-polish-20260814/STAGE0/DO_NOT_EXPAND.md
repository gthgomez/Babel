# Do not expand into default chat

Frozen product rule: quieter, not richer. These exist in-tree and must stay **opt-in / forensic / non-default**.

| Surface | Path | Why it stays out |
|---------|------|------------------|
| ThemeProvider migration | `ui/theme.ts` | UNUSED; helpers already work |
| Theme picker | `ui/themePicker.ts`, `interactive/commands/theme.ts` | Operator command, not daily chrome |
| Usage charts | `ui/usageCharts.ts` | Dashboard |
| Token history sparkline | `ui/tokenHistory.ts`, `renderTokenBarWithHistory` | Second row; status bar tests already forbid sparkline |
| Pane manager / extra panes | `ui/paneManager.ts`, `interactive/BabelRepl.ts` | Advanced layout |
| AgentTeamOverview / AgentProgressPane | `ui/agentProgress.ts` | TEST_ONLY in default; lying 100% bar |
| Permanent subagent tree | `ui/subAgentOverlay.ts` | OK as **transient** thinking overlay; not a standing tree |
| Expanded bg-task panel | `renderBackgroundTaskProgress` | Footer when tasks exist; not a persistent panel |
| Rate-limit widget (idle) | `ui/rateLimitWidget.ts` | Only if actually limited |
| Knowledge-graph indicator | `statusBar` `knowledgeGraph` | Dashboard |
| Routing cue | `routingLabel` | Forensic receipt |
| Deep/plan header dashboards | `ui/renderers.ts` `accentBright('BABEL')` stacks | Keep in those modes; do not copy into chat status |

#82 may add **one** calm current-activity line (`● Inspecting`) from existing `formatLiveActivity`, replacing or sitting in the thinking slot — not a live dashboard.
