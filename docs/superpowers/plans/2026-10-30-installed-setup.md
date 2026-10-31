<!-- License: Apache-2.0 - see LICENSE -->
# Installed setup implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guide fresh npm users to an explicit provider/model and show honest readiness and recovery.
**Architecture:** A reusable setup service persists progress in private user configuration and uses the established masked credential prompt. CLI setup and TUI startup consume the same state. Local prerequisite checks do not imply live connectivity.
**Tech Stack:** Existing readline/REPL, credential hub, installed doctor, presentation components.
**Spec:** `../specs/2026-10-30-cli-backend-coherence-design.md`

## Global constraints

- No default cloud connection or automatic inference on startup/help.
- Preserve remote tracing as opt-in and sandbox isolation.
- First-run progress is independent of cwd/history.
- Budget choice includes an explicit unlimited option; no invented dollar default.

## Review focus

- Empty environment/profile must show setup required, never Ready.
- Existing global executable must identify its actual version and path without changing installation.
- Interrupted setup must preserve completed non-secret choices.
- Missing key and 401 must have different actionable summaries.
- Non-TTY setup must provide usable instructions without waiting for input.

### Task 1: Shared setup flow and readiness

**Files:** create `babel-cli/src/services/providerSetup.ts`; modify `commands/coreStartupCommands.ts`, `ui/onboarding.ts`, `interactive/repl/replLifecycle.ts`, `interactive/session.ts`, `installedDoctor.ts`, `config/interactiveCredential.ts`.
**Interfaces:** `runProviderSetup(options): Promise<SetupResult>` uses injected input/output where practical. `getSetupStatus(env?, settings?): SetupStatus` reports setup_required/configured_unverified/action_required; connected requires explicit live evidence. Save connection/model/budget only after validation and confirmation; never save API keys in settings.

- [ ] Pin empty profile, interrupted flow, non-TTY, existing selection and missing sandbox cases through real entry points.
- [ ] Observe failures; implement the guided flow and connect startup, slash setup, CLI setup and doctor to it.
- [ ] Show effective connection/model, settings source, plan policy, prerequisites and short command orientation.
- [ ] Run onboarding/installed doctor/REPL lifecycle/consumer checks; inspect and commit.

### Task 2: Failure and defaults presentation

**Files:** modify `agent/chatFailureClassification.ts`, `agent/failureCard.ts`, `interactive/commands/modelDetail.ts`, `interactive/commands/info.ts`, `ui/statusBar.ts` (actual renderer owner as discovered), `babel-cli/README.md`.
**Interfaces:** failure presentation consumes provider/model and typed category, never vendor class names. Settings inventory reports runtime defaults and instruction sources, including unknown prices and unobserved model identity.

- [ ] Pin missing credentials, 401, quota, 429, unsupported model, cancellation and sandbox failures.
- [ ] Implement one actionable summary, accurate default/session provenance, and separate configuration from connectivity/readiness.
- [ ] Run failure/model/status tests and installed archive flow; inspect and commit.
