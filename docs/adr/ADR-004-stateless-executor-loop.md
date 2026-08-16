# ADR-004: Stateless Executor Loop

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
**Status:** Accepted  
**Date:** 2026-06-19  
**Deciders:** Babel team  

> **Scope amendment (2026-08-15):** The durable invariant of this ADR is that
> **provider-native conversational state is not authoritative execution state**. The
> unqualified sentence in Compliance ("All state is in the `executionHistory` string and the
> in-memory `toolCallLog` array") describes the original executor-loop implementation and is
> **no longer the full picture**: Babel now has durable task authority, event/session state,
> checkpoints, revision identity, verifier receipts, budgets, evidence, and completion
> authority (see [HARNESS_ARCHITECTURE_V1.md](../architecture/HARNESS_ARCHITECTURE_V1.md)).
> Future provider-native continuation may be used as an optional opaque/cognitive capability
> only if Babel-owned authoritative state remains independent.

## Context

Multi-turn tool execution can be implemented as either: (1) a stateful agent loop (the model maintains internal state across turns, like the Anthropic SDK's message history), or (2) a stateless text-loop (execution history is accumulated as a string and appended to the prompt on each iteration).

Stateful loops are simpler to implement but couple the system to a specific provider's state management. Stateless loops are more complex but provider-agnostic and easier to audit.

## Decision

We implemented a **stateless text-loop** for the CLI Executor (Stage 4). The canonical implementation lives in `babel-cli/src/pipeline/executorLoop.ts` (imported and called by `pipeline.ts`).

Each iteration:
1. Compiles a fresh prompt = base context (instruction stack + plan + safety rules) + execution history (accumulated tool calls and results) + next-action instruction
2. Calls `runWithFallback` expecting an `ExecutorTurn` (tool_call or completion signal)
3. If tool_call: executes the tool via `executeTool()`, appends the result to `executionHistory`
4. If completion: evaluates completion gates (pre-complete guards, runnable artifact gate, runtime verification)
5. Loops up to `MAX_EXECUTOR_TURNS` (20)

The executor is **not** coupled to any provider's state management. Every turn is a fresh, self-contained LLM call.

## Alternatives Considered

**Stateful agent loop (Anthropic SDK):** Simpler code, but ties the executor to a single provider. Would prevent waterfall routing across providers.

**Session-persistent agent (LangChain):** Adds dependency overhead. The stateless approach is simpler and more transparent.

## Consequences

**Benefits:**
- Provider-agnostic (any LLM that supports JSON output can drive the executor)
- Every turn is independently auditable (prompt + response + tool result)
- Waterfall routing works transparently (provider can change mid-loop)
- No state drift across turns

**Trade-offs:**
- Higher token consumption (full history re-sent every turn)
- Context window pressure on long-running tasks (mitigated by auto-compaction)
- LLM must re-derive state from history text rather than maintaining it internally
- History formatting (`formatHistoryEntry`) must be lossless

## Compliance

The executor loop must remain provider-agnostic. No provider-specific state management APIs may be introduced. All state is in the `executionHistory` string and the in-memory `toolCallLog` array.
