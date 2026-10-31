<!-- License: Apache-2.0 - see LICENSE -->
# Direct providers and release qualification implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete direct OpenAI/Gemini/Anthropic coding adapters and qualify every advertised operation.
**Architecture:** OpenAI uses the shared compatible implementation; Gemini/Anthropic retain native message/tool protocols. All emit existing inference events and use Babel tool execution authority. Explicit custom connections configure a protocol adapter; model names never imply provider identity.
**Tech Stack:** TypeScript, native fetch/SSE, existing provider fixtures and authority suites.
**Spec:** `../specs/2026-10-30-cli-backend-coherence-design.md`

## Global constraints

- No credential reads or live provider spending during deterministic qualification.
- Unsupported/unknown capabilities stay visible with a reason.
- No provider inference from model substrings and no silent provider changes.
- Keep requested/sent/observed identity separate; unknown cost is not zero.

## Review focus

- Fragmented tool argument streams must assemble exactly once.
- Gemini function responses must preserve request correlation and thought signatures.
- Anthropic tool results and system blocks must preserve conversation order.
- Aborted requests must stop reads/retries and finalize admission/accounting.
- Explicit endpoint configuration must never redirect a credential to a repository-controlled URL.

### Task 1: Direct provider adapters

**Files:** modify `runners/openAiApi.ts`, `runners/geminiApi.ts`, `runners/apiFallback.ts`, `runners/providerEngine.ts`, `runners/providerRegistry.ts`, `agent/providerCapabilities.ts`, `agent/chatModelPolicy.ts`; add focused native protocol modules and provider fixtures under existing owners.
**Interfaces:** all adapters implement `LlmRunner.execute`, `executeRaw`, `executeRawStream`, `executeWithToolsStream` and metadata using `ProviderMessage`, `ToolDefinition`, `ToolStreamEvent`. Preserve structured runner constructor compatibility. Native events cannot execute tools.

- [ ] Consult official wire documentation and pin request/stream/error/usage/cancellation cases with mocked fetch.
- [ ] Observe missing operation failures, implement native adapters and canonical factory wiring.
- [ ] Complete native Chat denial/result-delivery and authority conformance before enabling advertised operations.
- [ ] Run focused provider/authority/accounting tests and typecheck; inspect and commit.

### Task 2: Integrated qualification and delivery

**Files:** extend existing `babel-cli/src/commands/userCommandSmoke.test.ts`, provider and consumer suites; update `babel-cli/README.md` and changed architecture references.
**Interfaces:** preserve JSON schemas and legacy event IDs or explicitly version changes; all enabled providers resolve through the same selection contract.

- [ ] Exercise two connections for one provider, identical model names across providers, manual model entry and custom endpoint handling.
- [ ] Run affected regression suites, build/typecheck, architectural budgets, public content/secret gates, archive consumer flow and Windows terminal resize/cancellation journeys within host resources.
- [ ] Obtain fresh read-only reviews bound to the exact candidate; repair findings and rerun affected checks.
- [ ] Record any unavailable live qualification separately; do not claim model quality from fixtures.
- [ ] Commit and publish a task branch/PR through repository gates; integration requires all applicable evidence and existing authority.
