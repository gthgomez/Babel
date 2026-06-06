<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
-->

# Task Overlay: Terminal-Bench Autonomous CLI Tasks (v1.0)

**Category:** Task Overlay
**Status:** Active
**Layer:** 06_Task_Overlays
**Activation:** Load when the task is explicitly a Terminal-Bench or terminal-bench-style benchmark task.

---

## Purpose

Terminal-Bench tasks are judged by files and commands inside a disposable `/app` workspace. This
overlay describes only the benchmark harness contract. It does not teach how to solve benchmark
problems; task-solving behavior must come from the general domain and skill stack selected from the
actual problem statement.

## Harness Rules

- Treat the provided project root as `/app`; do not create a nested `app/` directory.
- Use concrete root-relative paths only.
- Write requested artifacts to the exact paths named by the task.
- Do not read hidden verifier tests or depend on paths outside the provided project root.
- Preserve run artifacts and terminal/headless output so later scoring can inspect what happened.

## Completion Rules

- Finish only after the requested output artifact exists at the exact requested path.
- Prefer a lightweight local sanity check before completion when the selected task skills define one.
