<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
-->


<!--
status: ACTIVE
last_verified: 2026-07-22
-->
# Babel CLI Market Research

This directory stores dated market-refresh snapshots and local product benchmark evidence for the Babel CLI gap roadmap.

## Monthly Refresh

Use official vendor docs as the source of truth and record:

- new market capability
- whether it is table-stakes, differentiating, or irrelevant to Babel
- current Babel equivalent
- scenario id, official source link, issue link, or explicit no-action decision

Refresh these surfaces:

- OpenAI Codex: CLI features, MCP, skills, subagents, hooks/rules/plugins, non-interactive automation
- Google Gemini CLI: tools, commands, checkpointing, configuration, extensions, sandboxing
- Anthropic Claude Code: overview/platforms, tools, hooks, MCP, skills, subagents/agent teams, checkpointing/worktrees, scheduled tasks

## Local Benchmark

Run:

```powershell
npm --prefix .\babel-cli run benchmark:product
```

or, after building `babel-cli`:

```powershell
node .\babel-cli\dist\index.js benchmark product --json
```

The harness writes `runs/benchmarks/product-gap-<UTC>.json` and records command timings, output, pass/fail checks, and the current capability scorecard baseline.

Every scenario should now carry:

- `user_scenario` — the concrete user job being measured
- `benchmark_question` — the question the probe answers
- `market_sources` — official docs backing the market expectation
- `target_outcome` — the Babel-specific result that would make the scenario successful

## Schema

`product-scorecard.schema.json` describes the scorecard portion used by the product-gap benchmark artifact. Keep it aligned with `babel-cli/src/services/productBenchmark.ts` whenever scenario evidence fields change.
