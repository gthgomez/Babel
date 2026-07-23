/**
 * execute.test.ts — Unit tests for pure functions in the LLM waterfall executor.
 *
 * Focuses on testable pure functions and offline fixtures. Skips async functions
 * that require LLM runner mocking (runWithFallback, runWaterfall, runDirectAsk).
 *
 * For schema-failure-ledger integration tests see execute.schemaFailureLedger.test.ts.
 * For reliability-repair-proof integration tests see execute.reliabilityRepairProof.test.ts.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';

import { EvidenceBundle } from './evidence.js';
import type { LlmRunner } from './runners/base.js';
import {
  RELIABILITY_REPAIR_PROOF_MARKER,
  buildPipelineV9OfflineFixtureResponse,
  buildReliabilityRepairProofExecutorResponse,
  buildStructuredOutputRetryPrompt,
  isStructuredOutputFailure,
  resetOfflineQaCallCount,
  runWaterfallForSchemaFailureTest,
} from './execute.js';
import type { RunOptions, PipelineStage } from './execute.js';

// ─── Helpers ────────────────────────────────────────────────────────────────────

function withEnv<K extends string, V extends string | undefined>(
  key: K,
  value: V,
  fn: () => void,
): void {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

function makeRunner(impl: Partial<LlmRunner>): LlmRunner {
  return {
    async execute<T>(): Promise<T> {
      throw new Error('not implemented');
    },
    getLastInvocationMetadata() {
      return null;
    },
    ...impl,
  };
}

// ─── resolveAggregateWaterfallTimeoutMs (internal) ──────────────────────────────
// This function is NOT exported. It reads BABEL_WATERFALL_TIMEOUT_MS from the
// environment at call time and returns the parsed positive finite number, or
// DEFAULT_WATERFALL_TIMEOUT_MS (180000) as the fallback.
//
// Called by:
//   - runWithFallback (exported)  — line 1573
//   - runWaterfallForSchemaFailureTest (exported)  — line 1831
//
// The timeout is exercised indirectly through these exported functions.
// For the indirect test, a mock runner that always fails is used with a short
// timeout to trigger the aggregate timeout error.

test('resolveAggregateWaterfallTimeoutMs: validates finite positive and returns timeout error prefix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-execute-timeout-'));
  const evidence = new EvidenceBundle('timeout test', root);
  const schema = z.object({ ok: z.literal(true) });
  const previous = process.env['BABEL_WATERFALL_TIMEOUT_MS'];

  process.env['BABEL_WATERFALL_TIMEOUT_MS'] = '50';
  try {
    const runner: LlmRunner = makeRunner({
      async execute<T>(): Promise<T> {
        throw new Error('transient error (not a cascade signal for timeout testing)');
      },
    });

    await assert.rejects(
      () =>
        runWaterfallForSchemaFailureTest({
          prompt: 'test prompt',
          schema,
          stage: 'executor',
          schemaName: 'TestSchema',
          evidence,
          maxAttempts: 2,
          tiers: [{ name: 'test-tier', runner }],
        }),
      (err: Error) => {
        // The retry backoff (1500ms) exceeds the 50ms timeout, so the
        // aggregate timeout error is thrown before the backoff delay.
        return err.message.startsWith('[waterfall-timeout]') && err.message.includes('limit 50ms');
      },
    );
  } finally {
    process.env['BABEL_WATERFALL_TIMEOUT_MS'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── isStructuredOutputFailure (exported) ───────────────────────────────────────

test('isStructuredOutputFailure: matches "zod validation failed"', () => {
  assert.equal(
    isStructuredOutputFailure(new Error('[deepInfraApi] Zod validation failed: expected object')),
    true,
  );
});

test('isStructuredOutputFailure: matches "invalid json"', () => {
  assert.equal(
    isStructuredOutputFailure(new Error('invalid json: unexpected token at position 42')),
    true,
  );
});

test('isStructuredOutputFailure: matches "failed to parse api response as json"', () => {
  assert.equal(
    isStructuredOutputFailure(new Error('failed to parse API response as JSON: SyntaxError')),
    true,
  );
});

test('isStructuredOutputFailure: is case-insensitive', () => {
  assert.equal(isStructuredOutputFailure(new Error('ZOD VALIDATION FAILED: array expected')), true);
  assert.equal(isStructuredOutputFailure(new Error('INVALID JSON in response body')), true);
  assert.equal(isStructuredOutputFailure(new Error('FAILED TO PARSE API RESPONSE AS JSON')), true);
});

test('isStructuredOutputFailure: does not match rate-limit errors', () => {
  const rateErrors = [
    'rate limit exceeded',
    'rate_limit: 429 too many requests',
    'quota exceeded',
    '429 Too Many Requests',
    'too many requests, please try again later',
  ];
  for (const msg of rateErrors) {
    assert.equal(isStructuredOutputFailure(new Error(msg)), false, `msg="${msg}"`);
  }
});

test('isStructuredOutputFailure: does not match spawn errors', () => {
  const spawnErrors = [
    'node is not recognized as an internal or external command',
    'enoent: no such file or directory',
    'bash not found in path',
  ];
  for (const msg of spawnErrors) {
    assert.equal(isStructuredOutputFailure(new Error(msg)), false, `msg="${msg}"`);
  }
});

test('isStructuredOutputFailure: does not match request timeout errors', () => {
  const timeoutErrors = [
    'request timeout after 30000ms',
    'aborterror: the operation was aborted',
    'aborted: connection closed',
  ];
  for (const msg of timeoutErrors) {
    assert.equal(isStructuredOutputFailure(new Error(msg)), false, `msg="${msg}"`);
  }
});

test('isStructuredOutputFailure: does not match generic errors', () => {
  assert.equal(isStructuredOutputFailure(new Error('something went wrong')), false);
  assert.equal(isStructuredOutputFailure(new Error('')), false);
  assert.equal(isStructuredOutputFailure(new Error('Connection refused')), false);
  assert.equal(isStructuredOutputFailure(new Error('ETIMEDOUT')), false);
});

test('isStructuredOutputFailure: partial-word matches do not false-positive', () => {
  // "invalid json" must not match a substring of something else
  assert.equal(isStructuredOutputFailure(new Error('invalid json5 format')), true); // "invalid json" is a prefix of "invalid json5"
  // "invalid" alone does not match
  assert.equal(isStructuredOutputFailure(new Error('invalid request')), false);
});

test('isStructuredOutputFailure: "zod" alone does not trigger', () => {
  // The signal is "zod validation failed", not just "zod"
  assert.equal(isStructuredOutputFailure(new Error('zod error: something broke')), false);
  assert.equal(isStructuredOutputFailure(new Error('validation failed')), false);
});

// ─── buildStructuredOutputRetryPrompt (exported) ────────────────────────────────

test('buildStructuredOutputRetryPrompt: includes original prompt and retry header', () => {
  const retryPrompt = buildStructuredOutputRetryPrompt(
    'Return the plan JSON.',
    new Error('Zod validation failed: ok expected boolean'),
  );
  assert.match(retryPrompt, /^Return the plan JSON\./);
  assert.match(retryPrompt, /BABEL STRUCTURED OUTPUT RETRY/);
  assert.match(retryPrompt, /Return exactly one raw JSON object/);
  assert.match(retryPrompt, /Do not omit required arrays/);
  assert.match(retryPrompt, /Do not include markdown, prose, comments, or code fences/);
});

test('buildStructuredOutputRetryPrompt: includes truncated error message', () => {
  const longMessage = 'x'.repeat(2500);
  const err = new Error(`Zod validation failed: ${longMessage}`);
  const retryPrompt = buildStructuredOutputRetryPrompt('test', err);

  // The error message is truncated to 1200 chars (including prefix "Zod validation failed: ")
  // So "Zod validation failed: " (23 chars) + 1177 x's = 1200 total
  assert.match(retryPrompt, /Validation failure: Zod validation failed: x{1177}$/m);
  // Verify it does NOT contain the full 2500 x's
  assert.doesNotMatch(retryPrompt, /x{2000}/);
});

test('buildStructuredOutputRetryPrompt: replaces multiline whitespace in error', () => {
  const err = new Error('Zod validation failed:  unexpected   token');
  const retryPrompt = buildStructuredOutputRetryPrompt('test', err);
  assert.match(retryPrompt, /Validation failure: Zod validation failed: unexpected token$/m);
});

test('buildStructuredOutputRetryPrompt: defaults schema name from stage', () => {
  const err = new Error('invalid json: EOF');
  const retryPrompt = buildStructuredOutputRetryPrompt('test', err, { stage: 'orchestrator' });
  assert.match(retryPrompt, /Schema target: OrchestratorOutputSchema/);
});

test('buildStructuredOutputRetryPrompt: infers schema name for planning stage', () => {
  const err = new Error('invalid json');
  const prompt = buildStructuredOutputRetryPrompt('test', err, { stage: 'planning' });
  assert.match(prompt, /Schema target: SwePlanSchema/);
});

test('buildStructuredOutputRetryPrompt: infers schema name for qa stage', () => {
  const err = new Error('invalid json');
  const prompt = buildStructuredOutputRetryPrompt('test', err, { stage: 'qa' });
  assert.match(prompt, /Schema target: QaVerdictSchema/);
});

test('buildStructuredOutputRetryPrompt: infers schema name for executor stage', () => {
  const err = new Error('invalid json');
  const prompt = buildStructuredOutputRetryPrompt('test', err, { stage: 'executor' });
  assert.match(prompt, /Schema target: ExecutorTurnSchema/);
});

test('buildStructuredOutputRetryPrompt: uses default schema name when no stage', () => {
  const err = new Error('invalid json');
  const prompt = buildStructuredOutputRetryPrompt('test', err);
  assert.match(prompt, /Schema target: StructuredOutputSchema/);
});

test('buildStructuredOutputRetryPrompt: overrides schema name with explicit option', () => {
  const err = new Error('invalid json');
  const prompt = buildStructuredOutputRetryPrompt('test', err, { schemaName: 'CustomSchema' });
  assert.match(prompt, /Schema target: CustomSchema/);
});

test('buildStructuredOutputRetryPrompt: stage takes priority for guidance, schemaName for schema label', () => {
  const err = new Error('invalid json');
  const prompt = buildStructuredOutputRetryPrompt('test', err, {
    stage: 'executor',
    schemaName: 'MySchema',
  });
  assert.match(prompt, /Schema target: MySchema/);
  assert.match(prompt, /Return exactly one executor turn variant/);
});

test('buildStructuredOutputRetryPrompt: orchestrator stage guidance', () => {
  const err = new Error('invalid json');
  const prompt = buildStructuredOutputRetryPrompt('test', err, { stage: 'orchestrator' });
  assert.match(prompt, /omit the swarm field entirely/);
  assert.match(prompt, /empty swarm means no swarm field/);
});

test('buildStructuredOutputRetryPrompt: planning stage guidance', () => {
  const err = new Error('invalid json');
  const prompt = buildStructuredOutputRetryPrompt('test', err, { stage: 'planning' });
  assert.match(prompt, /Return the complete SWE plan object/);
  assert.match(prompt, /do not replace arrays with strings or prose/);
});

test('buildStructuredOutputRetryPrompt: qa stage guidance mentions PASS and REJECT shapes', () => {
  const err = new Error('invalid json');
  const prompt = buildStructuredOutputRetryPrompt('test', err, { stage: 'qa' });
  assert.match(prompt, /For PASS, return the exact PASS verdict shape/);
  assert.match(prompt, /For REJECT, include at least one actionable failure/);
});

test('buildStructuredOutputRetryPrompt: executor stage guidance mentions turn variants', () => {
  const err = new Error('invalid json');
  const prompt = buildStructuredOutputRetryPrompt('test', err, { stage: 'executor' });
  assert.match(prompt, /Return exactly one executor turn variant/);
  assert.match(prompt, /For tool_call, include the tool discriminator/);
  assert.match(prompt, /For completion or halt, do not mix in tool-call fields/);
});

test('buildStructuredOutputRetryPrompt: default stage guidance for unknown stage', () => {
  const err = new Error('invalid json');
  const prompt = buildStructuredOutputRetryPrompt('test', err, { stage: 'unrecognized' });
  assert.match(prompt, /Match the requested schema exactly/);
  assert.match(prompt, /keep variant\/discriminator fields internally consistent/);
});

test('buildStructuredOutputRetryPrompt: includes shadow hints when provided', () => {
  const err = new Error('invalid json');
  const hints = [
    'Ensure plan_type is exactly IMPLEMENTATION_PLAN',
    'minimal_action_set must be a non-empty array',
  ];
  const prompt = buildStructuredOutputRetryPrompt('test', err, { shadowHints: hints });
  assert.match(prompt, /Schema shadow hints from previous failures/);
  assert.match(prompt, /1. Ensure plan_type is exactly IMPLEMENTATION_PLAN/);
  assert.match(prompt, /2. minimal_action_set must be a non-empty array/);
});

test('buildStructuredOutputRetryPrompt: no shadow hints section when hints empty', () => {
  const err = new Error('invalid json');
  const prompt = buildStructuredOutputRetryPrompt('test', err);
  assert.doesNotMatch(prompt, /Schema shadow hints/);
});

test('buildStructuredOutputRetryPrompt: separator between prompt and retry section', () => {
  const err = new Error('invalid json');
  const prompt = buildStructuredOutputRetryPrompt('original line', err);
  assert.match(prompt, /original line\n\n---/);
});

// ─── Timeout error factory/detector (internal) ──────────────────────────────────
// buildAggregateWaterfallTimeoutError and isAggregateWaterfallTimeoutError are NOT
// exported. They use the prefix constant '[waterfall-timeout]'.
//
// buildAggregateWaterfallTimeoutError is called by:
//   - runWaterfall (internal) — lines 1033, 1233, 1458, 1486
//
// isAggregateWaterfallTimeoutError is called by:
//   - runWaterfall (internal) — line 1393
//
// The prefix constant AGGREGATE_WATERFALL_TIMEOUT_PREFIX is '[waterfall-timeout]'.

test('aggregate timeout error prefix is [waterfall-timeout]', async () => {
  // Verify the prefix via the indirect timeout test trigger above.
  // This test confirms the error format by checking that when the timeout
  // is triggered, the error message starts with '[waterfall-timeout]'.
  const root = mkdtempSync(join(tmpdir(), 'babel-execute-prefix-'));
  const evidence = new EvidenceBundle('prefix test', root);
  const schema = z.object({ ok: z.literal(true) });
  const previous = process.env['BABEL_WATERFALL_TIMEOUT_MS'];

  process.env['BABEL_WATERFALL_TIMEOUT_MS'] = '30';
  try {
    const runner: LlmRunner = makeRunner({
      async execute<T>(): Promise<T> {
        throw new Error('generic transient error');
      },
    });

    await assert.rejects(
      () =>
        runWaterfallForSchemaFailureTest({
          prompt: 'test',
          schema,
          stage: 'executor',
          schemaName: 'TestSchema',
          evidence,
          maxAttempts: 2,
          tiers: [{ name: 'tier1', runner }],
        }),
      (err: Error) => {
        // The timeout error includes the label, timeout limit, and phase
        return (
          err.message.startsWith('[waterfall-timeout]') &&
          err.message.includes('executor') &&
          err.message.includes('waiting to retry')
        );
      },
    );
  } finally {
    process.env['BABEL_WATERFALL_TIMEOUT_MS'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('timeout error is not treated as structured output failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-execute-noso-'));
  const evidence = new EvidenceBundle('noso test', root);
  const schema = z.object({ ok: z.literal(true) });
  const previous = process.env['BABEL_WATERFALL_TIMEOUT_MS'];

  process.env['BABEL_WATERFALL_TIMEOUT_MS'] = '10';
  try {
    const runner: LlmRunner = makeRunner({
      async execute<T>(): Promise<T> {
        throw new Error('some error');
      },
    });

    await assert.rejects(
      () =>
        runWaterfallForSchemaFailureTest({
          prompt: 'test',
          schema,
          stage: 'executor',
          schemaName: 'TestSchema',
          evidence,
          maxAttempts: 2,
          tiers: [{ name: 'tier1', runner }],
        }),
      (err: Error) => {
        // Timeout errors are re-thrown directly (line 1393-1395) and never
        // treated as structured output failures
        return err.message.startsWith('[waterfall-timeout]');
      },
    );
  } finally {
    process.env['BABEL_WATERFALL_TIMEOUT_MS'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Cascade signal constants (internal) ───────────────────────────────────────
// RATE_LIMIT_SIGNALS, SPAWN_ERROR_SIGNALS, STRUCTURED_OUTPUT_FAILURE_SIGNALS,
// and REQUEST_TIMEOUT_SIGNALS are internal constants used by isImmediateCascade
// (also internal). STRUCTURED_OUTPUT_FAILURE_SIGNALS is exercised through the
// exported isStructuredOutputFailure function.
//
// isImmediateCascade is called by:
//   - runWaterfall (internal) — line 1475

test('cascade signal detection: rate-limit errors cause immediate cascade (indirect)', async () => {
  // When a runner throws a rate-limit error, isImmediateCascade returns true,
  // causing cascadeFromTier = true and breaking the attempt loop. This means
  // the runner gets only 1 attempt (no retry for rate-limit errors).
  const root = mkdtempSync(join(tmpdir(), 'babel-cascade-ratelimit-'));
  const evidence = new EvidenceBundle('rate-limit test', root);
  const schema = z.object({ ok: z.literal(true) });
  const previous = process.env['BABEL_WATERFALL_TIMEOUT_MS'];

  process.env['BABEL_WATERFALL_TIMEOUT_MS'] = '5000';
  try {
    let callCount = 0;
    const rateLimitRunner: LlmRunner = makeRunner({
      async execute<T>(): Promise<T> {
        callCount++;
        throw new Error('rate limit exceeded: 429 too many requests');
      },
    });

    // With only one tier and maxAttempts=2, but the rate-limit signal causes
    // immediate cascade, so only 1 attempt is made.
    // The waterfall should throw "All 1 runner(s) in the waterfall failed."
    await assert.rejects(
      () =>
        runWaterfallForSchemaFailureTest({
          prompt: 'test',
          schema,
          stage: 'executor',
          schemaName: 'TestSchema',
          evidence,
          maxAttempts: 2,
          tiers: [{ name: 'rate-limited-tier', runner: rateLimitRunner }],
        }),
      (err: Error) => {
        return err.message.includes('All 1 runner(s) in the waterfall failed');
      },
    );

    // Rate-limit causes immediate cascade — no retry, so only 1 call
    assert.equal(callCount, 1);
  } finally {
    process.env['BABEL_WATERFALL_TIMEOUT_MS'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('cascade signal detection: spawn errors cause immediate cascade (indirect)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-cascade-spawn-'));
  const evidence = new EvidenceBundle('spawn test', root);
  const schema = z.object({ ok: z.literal(true) });
  const previous = process.env['BABEL_WATERFALL_TIMEOUT_MS'];

  process.env['BABEL_WATERFALL_TIMEOUT_MS'] = '5000';
  try {
    let callCount = 0;
    const spawnErrorRunner: LlmRunner = makeRunner({
      async execute<T>(): Promise<T> {
        callCount++;
        throw new Error('ENOENT: node is not recognized as an internal or external command');
      },
    });

    await assert.rejects(
      () =>
        runWaterfallForSchemaFailureTest({
          prompt: 'test',
          schema,
          stage: 'executor',
          schemaName: 'TestSchema',
          evidence,
          maxAttempts: 2,
          tiers: [{ name: 'spawn-error-tier', runner: spawnErrorRunner }],
        }),
      (err: Error) => err.message.includes('All 1 runner(s) in the waterfall failed'),
    );

    // Spawn error causes immediate cascade — no retry
    assert.equal(callCount, 1);
  } finally {
    process.env['BABEL_WATERFALL_TIMEOUT_MS'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('cascade signal detection: request timeout causes immediate cascade (indirect)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-cascade-timeout-'));
  const evidence = new EvidenceBundle('timeout-cascade test', root);
  const schema = z.object({ ok: z.literal(true) });
  const previous = process.env['BABEL_WATERFALL_TIMEOUT_MS'];

  process.env['BABEL_WATERFALL_TIMEOUT_MS'] = '5000';
  try {
    let callCount = 0;
    const timeoutRunner: LlmRunner = makeRunner({
      async execute<T>(): Promise<T> {
        callCount++;
        throw new Error('AbortError: request timeout after 30000ms');
      },
    });

    await assert.rejects(
      () =>
        runWaterfallForSchemaFailureTest({
          prompt: 'test',
          schema,
          stage: 'executor',
          schemaName: 'TestSchema',
          evidence,
          maxAttempts: 2,
          tiers: [{ name: 'timeout-tier', runner: timeoutRunner }],
        }),
      (err: Error) => err.message.includes('All 1 runner(s) in the waterfall failed'),
    );

    // Request timeout causes immediate cascade — no retry
    assert.equal(callCount, 1);
  } finally {
    process.env['BABEL_WATERFALL_TIMEOUT_MS'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('structured output failure within tier triggers retry, not cascade (indirect)', async () => {
  // Structured output failures get ONE schema-focused retry before cascading.
  // This means with maxAttempts=2, a structured output failure should retry.
  // But if it fails twice, it cascades — all runners fail.
  const root = mkdtempSync(join(tmpdir(), 'babel-retry-struct-'));
  const evidence = new EvidenceBundle('struct retry test', root);
  const schema = z.object({ ok: z.literal(true) });
  const previous = process.env['BABEL_WATERFALL_TIMEOUT_MS'];

  process.env['BABEL_WATERFALL_TIMEOUT_MS'] = '10000';
  try {
    let callCount = 0;
    const structFailRunner: LlmRunner = makeRunner({
      async execute<T>(): Promise<T> {
        callCount++;
        throw new Error('Zod validation failed: ok expected true, got false');
      },
    });

    await assert.rejects(
      () =>
        runWaterfallForSchemaFailureTest({
          prompt: 'test',
          schema,
          stage: 'executor',
          schemaName: 'TestSchema',
          evidence,
          maxAttempts: 2,
          tiers: [{ name: 'struct-fail-tier', runner: structFailRunner }],
        }),
      (err: Error) => err.message.includes('All 1 runner(s) in the waterfall failed'),
    );

    // Structured output gets a retry — 2 calls for maxAttempts=2 (attempt + retry)
    assert.equal(callCount, 2);
  } finally {
    process.env['BABEL_WATERFALL_TIMEOUT_MS'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-cascade error within first attempt retries before cascading (indirect)', async () => {
  // A generic error (not matching any cascade signal) that fails on first
  // attempt gets retried (up to maxAttempts). Only the second failure cascades.
  const root = mkdtempSync(join(tmpdir(), 'babel-retry-generic-'));
  const evidence = new EvidenceBundle('generic retry test', root);
  const schema = z.object({ ok: z.literal(true) });
  const previous = process.env['BABEL_WATERFALL_TIMEOUT_MS'];

  process.env['BABEL_WATERFALL_TIMEOUT_MS'] = '10000';
  try {
    let callCount = 0;
    const genericFailRunner: LlmRunner = makeRunner({
      async execute<T>(): Promise<T> {
        callCount++;
        throw new Error('connection reset by peer');
      },
    });

    await assert.rejects(
      () =>
        runWaterfallForSchemaFailureTest({
          prompt: 'test',
          schema,
          stage: 'executor',
          schemaName: 'TestSchema',
          evidence,
          maxAttempts: 2,
          tiers: [{ name: 'generic-fail-tier', runner: genericFailRunner }],
        }),
      (err: Error) => err.message.includes('All 1 runner(s) in the waterfall failed'),
    );

    // Generic error gets retried — 2 calls for maxAttempts=2
    assert.equal(callCount, 2);
  } finally {
    process.env['BABEL_WATERFALL_TIMEOUT_MS'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── resetOfflineQaCallCount (exported) ─────────────────────────────────────────
// Note: This function resets a module-level counter that tracks QA calls.
// It is only meaningful when BABEL_PIPELINE_V9_OFFLINE=1 and the scenario
// is qa_reject_once or qa_reject_max.

test('resetOfflineQaCallCount resets QA call counter between scenario runs', () => {
  resetOfflineQaCallCount();
  const saved = process.env['BABEL_PIPELINE_V9_OFFLINE'];
  process.env['BABEL_PIPELINE_V9_OFFLINE'] = '1';
  const savedScenario = process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'];
  process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'] = 'qa_reject_once';

  try {
    const options: RunOptions = { stage: 'qa' };
    const prompt = 'Please produce a QA verdict for the plan.';

    // First call after reset → REJECT
    const first = buildPipelineV9OfflineFixtureResponse(prompt, options) as Record<string, unknown>;
    assert.equal(first.verdict, 'REJECT');

    // Second call → PASS
    const second = buildPipelineV9OfflineFixtureResponse(prompt, options) as Record<
      string,
      unknown
    >;
    assert.equal(second.verdict, 'PASS');

    // Reset back
    resetOfflineQaCallCount();

    // After reset, first call is REJECT again
    const afterReset = buildPipelineV9OfflineFixtureResponse(prompt, options) as Record<
      string,
      unknown
    >;
    assert.equal(afterReset.verdict, 'REJECT');

    // And second call after reset is PASS
    const afterReset2 = buildPipelineV9OfflineFixtureResponse(prompt, options) as Record<
      string,
      unknown
    >;
    assert.equal(afterReset2.verdict, 'PASS');
  } finally {
    resetOfflineQaCallCount();
    process.env['BABEL_PIPELINE_V9_OFFLINE'] = saved;
    process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'] = savedScenario;
  }
});

test('resetOfflineQaCallCount is safe to call multiple times', () => {
  // Should not throw — no state corruption
  resetOfflineQaCallCount();
  resetOfflineQaCallCount();
  resetOfflineQaCallCount();
});

// ─── buildPipelineV9OfflineFixtureResponse (exported) ───────────────────────────

test('buildPipelineV9OfflineFixtureResponse: returns null when env not set', () => {
  const result = buildPipelineV9OfflineFixtureResponse('test prompt', { stage: 'orchestrator' });
  assert.equal(result, null);
});

test('buildPipelineV9OfflineFixtureResponse: returns null when env set to non-"1"', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '0', () => {
    const result = buildPipelineV9OfflineFixtureResponse('test prompt', { stage: 'executor' });
    assert.equal(result, null);
  });
});

test('buildPipelineV9OfflineFixtureResponse: returns null when env set to empty string', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '', () => {
    const result = buildPipelineV9OfflineFixtureResponse('test prompt', { stage: 'executor' });
    assert.equal(result, null);
  });
});

// ── Standard lane (non-OTel) ──

test('buildPipelineV9OfflineFixtureResponse: standard lane, planning stage returns SWE plan', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    const result = buildPipelineV9OfflineFixtureResponse(
      'regression frontend verified lane. Please produce the SWE Plan.',
      { stage: 'planning' },
    ) as Record<string, unknown>;
    assert.notEqual(result, null);
    assert.equal(result.plan_type, 'IMPLEMENTATION_PLAN');
    assert.equal(result.plan_version, '1.0');
    assert.ok(Array.isArray(result.minimal_action_set));
    assert.ok((result.minimal_action_set as Array<unknown>).length > 0);
    assert.equal(
      (result.minimal_action_set as Array<Record<string, unknown>>)[0]!.tool,
      'file_read',
    );
  });
});

test('buildPipelineV9OfflineFixtureResponse: standard lane, frontend vs backend detection', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    // Frontend prompt → plan mentions "frontend"
    const frontendResult = buildPipelineV9OfflineFixtureResponse(
      'regression frontend verified lane task. produce the SWE Plan.',
      { stage: 'planning' },
    ) as Record<string, unknown>;
    assert.match(frontendResult.task_summary as string, /frontend/);

    // Backend prompt (no "regression frontend" prefix) → plan mentions "backend"
    const backendResult = buildPipelineV9OfflineFixtureResponse(
      'Please produce the SWE Plan for this backend task.',
      { stage: 'planning' },
    ) as Record<string, unknown>;
    assert.match(backendResult.task_summary as string, /backend/);
  });
});

test('buildPipelineV9OfflineFixtureResponse: standard lane, executor returns completion', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    const result = buildPipelineV9OfflineFixtureResponse('test', { stage: 'executor' }) as Record<
      string,
      unknown
    >;
    assert.notEqual(result, null);
    assert.equal(result.type, 'completion');
    assert.equal(result.status, 'EXECUTION_COMPLETE');
  });
});

test('buildPipelineV9OfflineFixtureResponse: standard lane, qa happy_path returns PASS', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    withEnv('BABEL_PIPELINE_V9_OFFLINE_SCENARIO', 'happy_path', () => {
      const result = buildPipelineV9OfflineFixtureResponse('produce a QA verdict for this plan.', {
        stage: 'qa',
      }) as Record<string, unknown>;
      assert.notEqual(result, null);
      assert.equal(result.verdict, 'PASS');
      assert.equal(result.overall_confidence, 5);
    });
  });
});

test('buildPipelineV9OfflineFixtureResponse: standard lane, qa_reject_once first call REJECT, second PASS', () => {
  resetOfflineQaCallCount();
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    withEnv('BABEL_PIPELINE_V9_OFFLINE_SCENARIO', 'qa_reject_once', () => {
      const firstResult = buildPipelineV9OfflineFixtureResponse('produce a QA verdict.', {
        stage: 'qa',
      }) as Record<string, unknown>;
      assert.equal(firstResult.verdict, 'REJECT');
      assert.equal(firstResult.overall_confidence, 2);
      assert.ok(Array.isArray(firstResult.failures));
      assert.equal(
        (firstResult.failures as Array<Record<string, unknown>>)[0]!.tag,
        'AMBIGUOUS_PLAN',
      );

      const secondResult = buildPipelineV9OfflineFixtureResponse('produce a QA verdict.', {
        stage: 'qa',
      }) as Record<string, unknown>;
      assert.equal(secondResult.verdict, 'PASS');
      assert.equal(secondResult.overall_confidence, 5);
    });
  });
  resetOfflineQaCallCount();
});

test('buildPipelineV9OfflineFixtureResponse: standard lane, qa_reject_max always returns REJECT', () => {
  resetOfflineQaCallCount();
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    withEnv('BABEL_PIPELINE_V9_OFFLINE_SCENARIO', 'qa_reject_max', () => {
      const first = buildPipelineV9OfflineFixtureResponse('produce a QA verdict.', {
        stage: 'qa',
      }) as Record<string, unknown>;
      assert.equal(first.verdict, 'REJECT');

      const second = buildPipelineV9OfflineFixtureResponse('produce a QA verdict.', {
        stage: 'qa',
      }) as Record<string, unknown>;
      assert.equal(second.verdict, 'REJECT');

      const third = buildPipelineV9OfflineFixtureResponse('produce a QA verdict.', {
        stage: 'qa',
      }) as Record<string, unknown>;
      assert.equal(third.verdict, 'REJECT');
    });
  });
  resetOfflineQaCallCount();
});

test('buildPipelineV9OfflineFixtureResponse: standard lane, evidence_loop returns EVIDENCE_REQUEST then SWE plan', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    withEnv('BABEL_PIPELINE_V9_OFFLINE_SCENARIO', 'evidence_loop', () => {
      // First call without evidence context → EVIDENCE_REQUEST
      const first = buildPipelineV9OfflineFixtureResponse('produce the SWE Plan.', {
        stage: 'planning',
      }) as Record<string, unknown>;
      assert.equal(first.plan_type, 'EVIDENCE_REQUEST');
      assert.equal(first.plan_version, '1.0');

      // Second call with evidence context → regular SWE plan
      const second = buildPipelineV9OfflineFixtureResponse(
        'EVIDENCE_REQUEST: evidence gathered, produce the SWE Plan.',
        { stage: 'planning' },
      ) as Record<string, unknown>;
      assert.equal(second.plan_type, 'IMPLEMENTATION_PLAN');
    });
  });
});

test('buildPipelineV9OfflineFixtureResponse: standard lane, orchestrator returns null', () => {
  // The standard (non-OTel) offline path does not handle orchestrator stage
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    const result = buildPipelineV9OfflineFixtureResponse('some task', { stage: 'orchestrator' });
    assert.equal(result, null);
  });
});

test('buildPipelineV9OfflineFixtureResponse: standard lane, mode fallback works', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    // mode: 'reasoning' should map to stage 'planning'
    const result = buildPipelineV9OfflineFixtureResponse('produce the SWE Plan.', {
      mode: 'reasoning',
    }) as Record<string, unknown>;
    assert.notEqual(result, null);
    assert.equal(result.plan_type, 'IMPLEMENTATION_PLAN');

    // Unrecognized stage/mode → null
    const unknown = buildPipelineV9OfflineFixtureResponse('test', {
      stage: 'orchestrator' as PipelineStage,
    });
    assert.equal(unknown, null);
  });
});

test('buildPipelineV9OfflineFixtureResponse: standard lane QA REJECT failure shape fields', () => {
  resetOfflineQaCallCount();
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    withEnv('BABEL_PIPELINE_V9_OFFLINE_SCENARIO', 'qa_reject_once', () => {
      const result = buildPipelineV9OfflineFixtureResponse('produce a QA verdict.', {
        stage: 'qa',
      }) as Record<string, unknown>;
      assert.equal(result.verdict, 'REJECT');
      const failures = result.failures as Array<Record<string, unknown>>;
      assert.ok(failures.length > 0);
      assert.equal(failures[0]!.tag, 'AMBIGUOUS_PLAN');
      assert.equal(failures[0]!.severity, 'blocker');
      assert.equal(failures[0]!.step_index, 0);
      assert.match(failures[0]!.description as string, /simulated QA rejection/);
    });
  });
  resetOfflineQaCallCount();
});

test('buildPipelineV9OfflineFixtureResponse: standard lane QA PASS does not include failures field', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    withEnv('BABEL_PIPELINE_V9_OFFLINE_SCENARIO', 'happy_path', () => {
      const result = buildPipelineV9OfflineFixtureResponse('produce a QA verdict.', {
        stage: 'qa',
      }) as Record<string, unknown>;
      assert.equal(result.verdict, 'PASS');
      assert.equal(result.overall_confidence, 5);
      assert.equal('failures' in result, false);
    });
  });
});

// ── OTel regression lane ──

test('buildPipelineV9OfflineFixtureResponse: OTel lane orchestrator returns manifest', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    const result = buildPipelineV9OfflineFixtureResponse(
      'OTel regression task. Analyze the task below and output the orchestration manifest.',
      { stage: 'orchestrator' },
    ) as Record<string, unknown>;
    assert.notEqual(result, null);
    assert.equal(result.orchestrator_version, '9.0');
    assert.equal(result.target_project, 'global');
    assert.equal((result.analysis as Record<string, unknown>).task_category, 'Backend');
    assert.equal((result.worker_configuration as Record<string, unknown>).assigned_model, 'qwen3');
    assert.equal(result.compilation_state as string, 'uncompiled');
  });
});

test('buildPipelineV9OfflineFixtureResponse: OTel lane triggered by stage alone', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    // Even without the "Analyze the task" phrase, OTel is detected by regex on the prompt
    const result = buildPipelineV9OfflineFixtureResponse('this is an otel autonomous lane task', {
      stage: 'orchestrator',
    }) as Record<string, unknown>;
    assert.notEqual(result, null);
    assert.equal(result.orchestrator_version, '9.0');
  });
});

test('buildPipelineV9OfflineFixtureResponse: OTel lane planning returns OTel-specific SWE plan', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    const result = buildPipelineV9OfflineFixtureResponse(
      'OTel verified lane: produce the SWE Plan.',
      { stage: 'planning' },
    ) as Record<string, unknown>;
    assert.notEqual(result, null);
    assert.equal(result.plan_type, 'IMPLEMENTATION_PLAN');
    // OTel plan references OTel-specific task summary
    assert.match(result.task_summary as string, /OTel tracing/);
  });
});

test('buildPipelineV9OfflineFixtureResponse: OTel lane QA returns PASS', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    const result = buildPipelineV9OfflineFixtureResponse('OTel regression: produce a QA verdict.', {
      stage: 'qa',
    }) as Record<string, unknown>;
    assert.notEqual(result, null);
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.overall_confidence, 5);
    assert.match(result.notes as string, /OTel regression fixture plan/);
  });
});

test('buildPipelineV9OfflineFixtureResponse: OTel lane executor returns tool_call before read, completion after', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    // First executor call: no execution history → tool_call to file_read
    const firstResult = buildPipelineV9OfflineFixtureResponse(
      'OTel regression lane executor turn.',
      { stage: 'executor' },
    ) as Record<string, unknown>;
    assert.notEqual(firstResult, null);
    assert.equal(firstResult.type, 'tool_call');
    assert.equal(firstResult.tool, 'file_read');
    assert.equal(firstResult.path, 'runs/latest/01_manifest.json');

    // Second executor call: file_read present in history → EXECUTION_COMPLETE
    const historyPrompt = [
      'OTel regression lane executor turn.',
      '### EXECUTION HISTORY',
      '[Step 1] file_read runs/latest/01_manifest.json',
      'Exit code: 0',
    ].join('\n');
    const secondResult = buildPipelineV9OfflineFixtureResponse(historyPrompt, {
      stage: 'executor',
    }) as Record<string, unknown>;
    assert.equal(secondResult.type, 'completion');
    assert.equal(secondResult.status, 'EXECUTION_COMPLETE');
  });
});

// ── Env var edge cases ──

test('buildPipelineV9OfflineFixtureResponse: scenario defaults to happy_path', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    delete process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'];
    const result = buildPipelineV9OfflineFixtureResponse('produce a QA verdict.', {
      stage: 'qa',
    }) as Record<string, unknown>;
    assert.equal(result.verdict, 'PASS');
  });
});

test('buildPipelineV9OfflineFixtureResponse: scenario with extra whitespace is trimmed', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    withEnv('BABEL_PIPELINE_V9_OFFLINE_SCENARIO', '  evidence_loop  ', () => {
      const result = buildPipelineV9OfflineFixtureResponse('produce the SWE Plan.', {
        stage: 'planning',
      }) as Record<string, unknown>;
      assert.equal(result.plan_type, 'EVIDENCE_REQUEST');
    });
  });
});

test('buildPipelineV9OfflineFixtureResponse: OTel with "otel regression" (lowercase)', () => {
  withEnv('BABEL_PIPELINE_V9_OFFLINE', '1', () => {
    const result = buildPipelineV9OfflineFixtureResponse(
      'otel regression task: produce the SWE Plan.',
      { stage: 'planning' },
    ) as Record<string, unknown>;
    assert.notEqual(result, null);
    assert.match((result as Record<string, unknown>).task_summary as string, /OTel tracing/);
  });
});

// ─── buildReliabilityRepairProofExecutorResponse (exported) ─────────────────────
// Note: Some basic scenarios are already tested in execute.reliabilityRepairProof.test.ts.
// This section adds coverage for the advanced state transitions.

function makeRepairProofPrompt(scenario: {
  fileReadCount?: number;
  writeCount?: number;
  verifierExitCodes?: number[];
  hasFailureCapsule?: boolean;
  marker?: boolean;
}): string {
  const lines: string[] = [];
  if (scenario.marker !== false) {
    lines.push(`Reliability repair proof marker: ${RELIABILITY_REPAIR_PROOF_MARKER}`);
  }
  lines.push('Approved SWE Plan targets src/math.js.');
  lines.push('Run node --test before completing.');
  lines.push('### EXECUTION HISTORY SO FAR:');

  const readCount = scenario.fileReadCount ?? 1;
  for (let i = 0; i < readCount; i++) {
    lines.push(`[Step ${i + 1}] file_read src/math.js`);
    lines.push('Exit code: 0');
  }

  const writeCount = scenario.writeCount ?? 0;
  for (let i = 0; i < writeCount; i++) {
    lines.push(`[Step ${readCount + i + 1}] file_write src/math.js`);
    lines.push('Exit code: 0');
  }

  const exitCodes = scenario.verifierExitCodes ?? [];
  for (let i = 0; i < exitCodes.length; i++) {
    lines.push(`[Step ${readCount + writeCount + i + 1}] test_run node --test`);
    lines.push(`Exit code: ${exitCodes[i]}`);
  }

  if (scenario.hasFailureCapsule) {
    lines.push('Failure capsule id: repair_failure_capsule_attempt_1');
  }

  return lines.join('\n');
}

test('buildReliabilityRepairProofExecutorResponse: null when stage is not executor', () => {
  withEnv('BABEL_RELIABILITY_REPAIR_PROOF', 'true', () => {
    const result = buildReliabilityRepairProofExecutorResponse('test', { stage: 'planning' });
    assert.equal(result, null);
  });
});

test('buildReliabilityRepairProofExecutorResponse: returns tool_call file_write after file_read', () => {
  withEnv('BABEL_RELIABILITY_REPAIR_PROOF', 'true', () => {
    const prompt = makeRepairProofPrompt({ fileReadCount: 1, writeCount: 0 });
    const result = buildReliabilityRepairProofExecutorResponse(prompt, {
      stage: 'executor',
    }) as Record<string, unknown>;
    assert.equal(result.type, 'tool_call');
    assert.equal(result.tool, 'file_write');
    assert.equal(result.path, 'src/math.js');
    // First write has wrong implementation (a * b)
    assert.match(result.content as string, /return a \* b/);
  });
});

test('buildReliabilityRepairProofExecutorResponse: returns test_run after file_write', () => {
  withEnv('BABEL_RELIABILITY_REPAIR_PROOF', 'true', () => {
    // After 1 file_read and 1 file_write, writeCount===verifierExitCodes.length is false
    // (1 <= 0 is false), so it enters the test_run branch (writeCount > verifierExitCodes.length)
    const prompt = makeRepairProofPrompt({
      fileReadCount: 1,
      writeCount: 1,
      verifierExitCodes: [],
    });
    const result = buildReliabilityRepairProofExecutorResponse(prompt, {
      stage: 'executor',
    }) as Record<string, unknown>;
    assert.equal(result.type, 'tool_call');
    assert.equal(result.tool, 'test_run');
    assert.equal(result.command, 'node --test');
  });
});

test('buildReliabilityRepairProofExecutorResponse: halts when verifier fails and no failure capsule', () => {
  withEnv('BABEL_RELIABILITY_REPAIR_PROOF', 'true', () => {
    const prompt = makeRepairProofPrompt({
      fileReadCount: 1,
      writeCount: 1,
      verifierExitCodes: [1],
      hasFailureCapsule: false,
    });
    const result = buildReliabilityRepairProofExecutorResponse(prompt, {
      stage: 'executor',
    }) as Record<string, unknown>;
    assert.equal(result.type, 'completion');
    assert.equal(result.status, 'EXECUTION_HALTED');
    assert.equal(result.halt_tag, 'STEP_VERIFICATION_FAIL');
  });
});

test('buildReliabilityRepairProofExecutorResponse: writes correct implementation after verifier failure with capsule', () => {
  withEnv('BABEL_RELIABILITY_REPAIR_PROOF', 'true', () => {
    const prompt = makeRepairProofPrompt({
      fileReadCount: 1,
      writeCount: 1,
      verifierExitCodes: [1],
      hasFailureCapsule: true,
    });
    const result = buildReliabilityRepairProofExecutorResponse(prompt, {
      stage: 'executor',
    }) as Record<string, unknown>;
    assert.equal(result.type, 'tool_call');
    assert.equal(result.tool, 'file_write');
    assert.equal(result.path, 'src/math.js');
    // Correct implementation: a + b
    assert.match(result.content as string, /return a \+ b/);
  });
});

test('buildReliabilityRepairProofExecutorResponse: with forceStillFail returns broken implementation', () => {
  withEnv('BABEL_RELIABILITY_REPAIR_PROOF', 'true', () => {
    withEnv('BABEL_RELIABILITY_REPAIR_PROOF_FORCE_STILL_FAIL', 'true', () => {
      const prompt = makeRepairProofPrompt({
        fileReadCount: 1,
        writeCount: 1,
        verifierExitCodes: [1],
        hasFailureCapsule: true,
      });
      const result = buildReliabilityRepairProofExecutorResponse(prompt, {
        stage: 'executor',
      }) as Record<string, unknown>;
      assert.equal(result.type, 'tool_call');
      assert.equal(result.tool, 'file_write');
      assert.match(result.content as string, /a \* b/);
      assert.match(result.content as string, /forced failure retry/);
    });
  });
});

test('buildReliabilityRepairProofExecutorResponse: completes when verifier passes after failures', () => {
  withEnv('BABEL_RELIABILITY_REPAIR_PROOF', 'true', () => {
    const prompt = makeRepairProofPrompt({
      fileReadCount: 1,
      writeCount: 2,
      verifierExitCodes: [1, 0],
      hasFailureCapsule: true,
    });
    const result = buildReliabilityRepairProofExecutorResponse(prompt, {
      stage: 'executor',
    }) as Record<string, unknown>;
    assert.equal(result.type, 'completion');
    assert.equal(result.status, 'EXECUTION_COMPLETE');
  });
});

test('buildReliabilityRepairProofExecutorResponse: reaches unexpected state fallback', () => {
  withEnv('BABEL_RELIABILITY_REPAIR_PROOF', 'true', () => {
    // Construct a prompt where:
    // - fileReadCount > 0 (skip file_read branch)
    // - writeCount > 0 (skip file_write branch)
    // - writeCount === verifierExitCodes.length (skip test_run branch)
    // - lastVerifierExitCode === 0 (skip "verifier failed" branches)
    // - failedVerifierCount === 0 (skip "verifier passes after failures" branch)
    // → Falls through to final fallback
    const prompt = makeRepairProofPrompt({
      fileReadCount: 2,
      writeCount: 2,
      verifierExitCodes: [0, 0],
      hasFailureCapsule: false,
    });
    const result = buildReliabilityRepairProofExecutorResponse(prompt, {
      stage: 'executor',
    }) as Record<string, unknown>;
    assert.equal(result.type, 'completion');
    assert.equal(result.status, 'EXECUTION_HALTED');
    assert.equal(result.halt_tag, 'STEP_VERIFICATION_FAIL');
    assert.match(result.condition as string, /unexpected executor prompt state/);
  });
});

test('buildReliabilityRepairProofExecutorResponse: writes force-still-fail increments retry counter', () => {
  withEnv('BABEL_RELIABILITY_REPAIR_PROOF', 'true', () => {
    withEnv('BABEL_RELIABILITY_REPAIR_PROOF_FORCE_STILL_FAIL', 'true', () => {
      // Multiple failures to test the failedVerifierCount in the message
      const prompt = makeRepairProofPrompt({
        fileReadCount: 1,
        writeCount: 1,
        verifierExitCodes: [1, 1, 1],
        hasFailureCapsule: true,
      });
      const result = buildReliabilityRepairProofExecutorResponse(prompt, {
        stage: 'executor',
      }) as Record<string, unknown>;
      assert.equal(result.type, 'tool_call');
      // 3 failures means failedVerifierCount = 3, so retry 3+1 = 4
      assert.match(result.content as string, /forced failure retry 4/);
    });
  });
});

test('buildReliabilityRepairProofExecutorResponse: returns null when src/math.js not in prompt', () => {
  withEnv('BABEL_RELIABILITY_REPAIR_PROOF', 'true', () => {
    const prompt = `Some task without src/math.js. Marker: ${RELIABILITY_REPAIR_PROOF_MARKER}`;
    const result = buildReliabilityRepairProofExecutorResponse(prompt, { stage: 'executor' });
    assert.equal(result, null);
  });
});

test('buildReliabilityRepairProofExecutorResponse: returns null when node --test not in prompt', () => {
  withEnv('BABEL_RELIABILITY_REPAIR_PROOF', 'true', () => {
    const prompt = `Marker: ${RELIABILITY_REPAIR_PROOF_MARKER}. Targets src/math.js. No test command.`;
    const result = buildReliabilityRepairProofExecutorResponse(prompt, { stage: 'executor' });
    assert.equal(result, null);
  });
});

// ─── RELIABILITY_REPAIR_PROOF_MARKER constant ────────────────────────────────────

test('RELIABILITY_REPAIR_PROOF_MARKER has expected value', () => {
  assert.equal(
    RELIABILITY_REPAIR_PROOF_MARKER,
    '[BABEL_RELIABILITY_AUTONOMOUS_LIVE_FAIL_THEN_PASS]',
  );
});
