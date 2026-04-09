# Babel Directory Structure

This document explains the numbered layer taxonomy used throughout this repo.

---

## Layer Overview

Babel uses a numbered directory system to enforce load order. Each layer has a specific responsibility. When the resolver assembles a stack, it loads layers in this order:

```
00_System_Router       ← Entry point: routes tasks to the right domain/lane
01_Behavioral_OS       ← Universal execution behavior applied to every stack
02_Domain_Architects   ← Technical strategy shells (backend, frontend, Android, etc.)
02_Skills              ← Reusable technical rules loaded by the resolver
03_Model_Adapters      ← Model-specific delivery shaping (Claude, GPT, Gemini, etc.)
04_Meta_Tools          ← Catalog governance and MCP adapter docs
05_Project_Overlays    ← Per-project context injected on top of domain + skills
06_Task_Overlays       ← Per-task deltas applied last, narrowest scope
```

---

## Layer Details

### `00_System_Router`
Contains the typed orchestrator (`OLS-v9-Orchestrator.md`). This is where task routing logic lives — it classifies the incoming task and determines which domain architect and skills to load.

### `01_Behavioral_OS`
Universal behavioral rules that apply to every assembled stack regardless of domain. Think of this as the base OS that every prompt stack runs on top of. You cannot opt out of this layer.

### `02_Domain_Architects`
Technical strategy shells for major domains:
- `Backend/` — server-side patterns, API design, database
- `Frontend/` — React, TypeScript, Vite, CSS patterns
- `Mobile/` — Android, Jetpack Compose, Gradle

These define the strategic framing for a task. Skills fill in the tactical details.

### `02_Skills`
Reusable technical rule sets that a domain architect can load. Skills are narrow and composable — a single skill covers one topic (e.g., Stripe webhook handling, Deno edge functions, RLS policy auditing).

Skills are registered in `prompt_catalog.yaml` with tags and token budgets.

### `03_Model_Adapters`
Model-specific delivery shaping. The same domain + skills stack may produce different output depending on whether the target model is Claude, GPT, Gemini, or Codex. Adapters handle that difference without polluting the core skill definitions.

### `04_Meta_Tools`
Catalog governance rules and MCP adapter documentation. Not prompt content — tooling for how Babel manages and validates its own catalog.

### `05_Project_Overlays`
Project-scoped context injected on top of domain + skills. Overlays answer "what is specific to this codebase?" without duplicating skill content. Public examples are named `Example-*`.

### `06_Task_Overlays`
The narrowest scope — per-task deltas applied last. These override or extend a specific task execution without changing the underlying domain or skill definitions.

---

## Resolution Order

When `babel resolve` or `tools/resolve-local-stack.ps1` runs:

1. Router classifies the task and selects a domain
2. Domain architect's default skills are loaded
3. Skill dependencies are expanded
4. Conflict checks run
5. Model adapter shaping is applied
6. Project overlay (if any) is injected
7. Task overlay (if any) is applied last
8. Ordered manifest is emitted

The result is deterministic given the same inputs. This is testable — see `examples/manifest-previews/` for checked-in golden outputs.

---

## Key File: `prompt_catalog.yaml`

The canonical registry for all routable assets. Every skill, domain, and overlay that the resolver can load must be registered here with:
- `path`: relative path to the prompt file
- `tags`: searchable metadata
- `token_budget`: estimated token cost when loaded
- `depends_on` (optional): other skills that must load first

---

## Key File: `START_HERE.md`

The recommended onboarding entry point. Read this before anything else.
