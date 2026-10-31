<!-- License: Apache-2.0 - see LICENSE -->
# Shared inference implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove vendor ownership of shared inference and centralize runner construction without changing admitted requests.
**Architecture:** Extract the existing compatible runner; keep thin vendor configuration and compatibility exports. ProviderEngine owns construction; caller policy owns routing and campaign selection.
**Tech Stack:** TypeScript strict, Node 22+, ESM, native fetch, existing node:test suites.
**Spec:** `../specs/2026-10-30-cli-backend-coherence-design.md`

## Global constraints

- Preserve harness-v1 completion authority, prepared request digests, admission, budget settlement, retries and cancellation.
- No live inference or ambient credential use during qualification.
- Keep legacy imports and environment names through a documented transition release.

## Review focus

- A 401 from OpenRouter must name OpenRouter, never DeepInfra.
- Zero retries must mean one attempt.
- Campaign caps must be applied before request preparation and hashing.
- Two vendors sharing a model name must retain different route identities.
- Missing selection must fail before inference, without a fallback provider.

### Task 1: Extract compatible protocol

**Files:** create `babel-cli/src/runners/protocol/openai-chat-completions.ts`; modify `deepInfraApi.ts`, `openRouterApi.ts`, `ollamaApi.ts`, `commandCodeApi.ts`, `openCodeApi.ts`, `openCodeGoApi.ts`, `providerResponsePolicy.ts`, `providerResponseStream.ts` under `babel-cli/src/runners/`.
**Interfaces:** `OpenAiCompatibleRunner` retains the existing constructor and runner methods; protected `sealCampaignWireBody(body, callbacks)` is a neutral hook. DeepInfra supplies endpoint and credential defaults; OpenRouter owns its campaign transformation. Neutral `BABEL_PROVIDER_*` settings precede legacy `BABEL_DEEPINFRA_*`.

- [ ] Characterize provider identity, exact body, tool stream, retry zero, timeout and campaign request behavior in existing provider tests.
- [ ] Run the focused provider cases and observe the new expectations fail.
- [ ] Extract the implementation, migrate unrelated inheritance, retain compatibility type exports, and move campaign-specific policy into OpenRouter.
- [ ] Run provider, prepared-request, native admission and campaign tests; run package typecheck.
- [ ] Inspect and commit the coherent extraction.

### Task 2: Canonical construction and auxiliary routes

**Files:** modify `runners/providerEngine.ts`, `agent/chatEngineProviderRuntime.ts`, `agent/chatEngineCriticBudget.ts`, `agent/chatEngineObservability.ts`, `execute.ts`, `services/askAnswer.ts`, `services/smallFixProvider.ts` under `babel-cli/src/`.
**Interfaces:** `createProviderRunner(options: ProviderEngineOptions): ProviderEngine`; expose existing preparation/metadata methods by delegation. Extend options for exact-model policy, explicit endpoint and credential references. Chat uses the runner interface rather than vendor union identity.

- [ ] Add regressions for same-provider auxiliary inheritance, absent selection and prohibited implicit substitution.
- [ ] Run the focused cases to establish failures.
- [ ] Route construction through ProviderEngine; retain explicit campaign and Go budget restrictions; remove credential-driven cross-provider catch/fallback chains.
- [ ] Run Chat preparation/accounting, critic, compaction and provider conformance checks plus typecheck.
- [ ] Inspect and commit the factory migration.
