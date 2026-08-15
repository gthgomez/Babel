import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { EvidenceBundle } from './evidence.js';
import { runWaterfallForSchemaFailureTest } from './execute.js';
import type { LlmRunner } from './runners/base.js';

test('P1-I: waterfall telemetry records task_class and reasoning_effort when provided', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-telemetry-test-'));
  const evidence = new EvidenceBundle('telemetry test', root);
  const schema = z.object({ ok: z.literal(true) });
  const runner: LlmRunner = {
    async execute<T>(_prompt: string, activeSchema: z.ZodType<T, unknown>): Promise<T> {
      return activeSchema.parse({ ok: true });
    },
    getLastInvocationMetadata() {
      return {
        provider: 'test-provider',
        provider_model_id: 'test-model',
        latency_ms: 1,
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        estimated_cost_usd: 0,
      };
    },
  };

  try {
    await runWaterfallForSchemaFailureTest({
      prompt: 'Return ok JSON.',
      schema,
      stage: 'executor',
      schemaName: 'ExecutorTurnSchema',
      evidence,
      maxAttempts: 1,
      tiers: [{ name: 'test-tier', runner }],
      taskClass: 'general_swe',
      reasoningEffort: 'high',
    });
    evidence.writeWaterfallTelemetry();

    const telemetry = JSON.parse(
      readFileSync(join(evidence.runDir, '05_waterfall_telemetry.json'), 'utf-8'),
    ) as Array<Record<string, unknown>>;
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0]?.['task_class'], 'general_swe');
    assert.equal(telemetry[0]?.['reasoning_effort'], 'high');
    // Existing fields untouched.
    assert.equal(telemetry[0]?.['stage'], 'executor');
    assert.equal(telemetry[0]?.['tier_succeeded'], 'test-tier');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P1-I: telemetry omits the new fields when not provided (backward compatible)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-telemetry-test-'));
  const evidence = new EvidenceBundle('telemetry test 2', root);
  const schema = z.object({ ok: z.literal(true) });
  const runner: LlmRunner = {
    async execute<T>(_prompt: string, activeSchema: z.ZodType<T, unknown>): Promise<T> {
      return activeSchema.parse({ ok: true });
    },
  };
  try {
    await runWaterfallForSchemaFailureTest({
      prompt: 'Return ok JSON.',
      schema,
      stage: 'executor',
      schemaName: 'ExecutorTurnSchema',
      evidence,
      maxAttempts: 1,
      tiers: [{ name: 'test-tier', runner }],
    });
    evidence.writeWaterfallTelemetry();
    const telemetry = JSON.parse(
      readFileSync(join(evidence.runDir, '05_waterfall_telemetry.json'), 'utf-8'),
    ) as Array<Record<string, unknown>>;
    assert.equal(telemetry[0]?.['task_class'], undefined);
    assert.equal(telemetry[0]?.['reasoning_effort'], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
