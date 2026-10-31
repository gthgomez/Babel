<!-- License: Apache-2.0 - see LICENSE -->
# Commands and effective settings implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CLI/TUI command and setting semantics consistent and planning read-only by default.
**Architecture:** Derive registered CLI names from Commander; share application command handlers with slash commands. One user-owned configuration/resolver records connection identity and settings provenance. Preserve internal harness mode IDs.
**Tech Stack:** TypeScript, Commander, existing REPL, JSON user configuration, node:test.
**Spec:** `../specs/2026-10-30-cli-backend-coherence-design.md`

## Global constraints

- Settings precedence: invocation, session, explicit environment, trusted user-owned project override, user default, built-in.
- `plans.autoApply` defaults to false; explicit plan-only intent overrides it.
- No secrets in settings, command arguments, status or project configuration.
- Legacy commands retain their effects and receive migration guidance.

## Review focus

- `exec`, `daemon`, and `goal` help must reach their own handlers.
- Saved Plan defaults must apply before built-in Chat initialization.
- Invalid setting updates must preserve the previous file and unknown fields.
- Retargeting must invalidate pending plan and runner selection.
- Auto-apply cannot override a read-only restriction or stale project/plan binding.

### Task 1: Configuration and command routing

**Files:** create `babel-cli/src/config/userSettings.ts`, `babel-cli/src/commands/connectionCommands.ts`; modify `cli/argv.ts`, `cliMain.ts`, `commands/coreCommands.ts`, `interactive/commands.ts`, `interactive/types.ts`, `interactive/commands/config.ts`, `interactive/commands/permissions.ts`, `interactive/session.ts`, `config/projectSettings.ts`.
**Interfaces:** `readUserSettings(): UserSettings`, `updateUserSettings(update): void`, `resolveEffectiveSettings({projectRoot?, session?, invocation?, env?}): EffectiveSettings`; each resolved field carries value/source. `Connection` stores ID/provider/model/endpoint/credential env reference, never a key. `registerConnectionCommands(program)` and `handleConnectionCommand(ctx, name, args)` share the service.

- [ ] Pin CLI help registration, session versus saved selections, precedence, unknown-field preservation, custom connection and invalid write behavior in existing/new focused suites.
- [ ] Observe failure, then replace manual top-level recognition with actual registered names and add canonical provider/model/settings commands.
- [ ] Wire session selection, engine invalidation, saved defaults and provenance to the same resolver; preserve aliases.
- [ ] Run command/parser/session/config suites and package typecheck.
- [ ] Inspect and commit.

### Task 2: Workflow consolidation and plan application

**Files:** modify `agent/planExecuteMode.ts`, `interactive/commands/config.ts`, `interactive/execution/chatCore.ts`, `interactive/types.ts`, `commands/workflowCommands.ts`, `cli/argv.ts`, `config/runtimeMode.ts`; update normative architecture/ADR when semantics change.
**Interfaces:** public Work maps to internal Chat; Plan retains read-only harness policy; thorough Work maps to Deep. Pending plan identity includes project and source scope. Explicit apply validates that identity before staging implementation. Trusted `plans.autoApply` changes only the transition, never authority.

- [ ] Pin `/mode plan`, Work alias, explicit plan-only, default no-auto-apply and stale plan rejection.
- [ ] Observe failures; fix workflow dispatch before operator aliases, separate presentation/permission names, and wire bounded plan application.
- [ ] Add canonical recovery/display namespaces without reinterpreting legacy `apply`/`resume` effects.
- [ ] Run plan/authority/session tests, update help and migration documentation, inspect and commit.
