import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { z } from 'zod';

import { EvidenceBundle } from './evidence.js';
import { runWaterfallForSchemaFailureTest } from './execute.js';
import { buildStructuredOutputError, type LlmRunner } from './runners/base.js';
import { SCHEMA_FAILURE_LEDGER_FILENAME } from './services/schemaFailureLedger.js';

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf-8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

test('waterfall writes schema failure ledger entries and recovery evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-waterfall-schema-ledger-'));
  const evidence = new EvidenceBundle('waterfall schema ledger test', root);
  const schema = z.object({ ok: z.literal(true) });
  let calls = 0;
  const runner: LlmRunner = {
    async execute<T>(_prompt: string, activeSchema: z.ZodType<T, unknown>): Promise<T> {
      calls += 1;
      if (calls === 1) {
        throw buildStructuredOutputError({
          failure_kind: 'zod_validation_failed',
          provider: 'test-provider',
          model: 'test-model',
          message: '[testProvider] Zod validation failed (test-model): ok expected true',
          raw_output: '{"ok":false}',
          parsed_json: { ok: false },
          zod_issues: [
            {
              path: ['ok'],
              code: 'invalid_value',
              message: 'Invalid input: expected true',
            },
          ],
        });
      }
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
    const result = await runWaterfallForSchemaFailureTest({
      prompt: 'Return ok JSON.',
      schema,
      stage: 'executor',
      schemaName: 'ExecutorTurnSchema',
      evidence,
      maxAttempts: 2,
      tiers: [{ name: 'test-tier', runner }],
    });
    evidence.writeWaterfallTelemetry();

    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);

    const ledger = readJsonl(join(evidence.runDir, SCHEMA_FAILURE_LEDGER_FILENAME));
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0]?.['retry_outcome'], 'pending_retry');
    assert.equal(ledger[0]?.['failure_kind'], 'zod_validation_failed');
    assert.equal(ledger[1]?.['retry_outcome'], 'recovered');
    assert.deepEqual(ledger[1]?.['recovered_schema_failure_entry_ids'], [ledger[0]?.['entry_id']]);

    const telemetry = JSON.parse(readFileSync(join(evidence.runDir, '05_waterfall_telemetry.json'), 'utf-8')) as Array<{
      schema_failure_entry_ids?: string[];
      attempts_detail?: Array<{ schema_failure_entry_id?: string | null }>;
    }>;
    assert.equal(telemetry[0]?.schema_failure_entry_ids?.length, 2);
    assert.equal(telemetry[0]?.attempts_detail?.[0]?.schema_failure_entry_id, ledger[0]?.['entry_id']);
    assert.equal(telemetry[0]?.attempts_detail?.[1]?.schema_failure_entry_id, ledger[1]?.['entry_id']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('waterfall records fatal schema exhaustion when no tier recovers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-waterfall-schema-fatal-'));
  const evidence = new EvidenceBundle('waterfall schema fatal test', root);
  const schema = z.object({ ok: z.literal(true) });
  const runner: LlmRunner = {
    async execute<T>(): Promise<T> {
      throw buildStructuredOutputError({
        failure_kind: 'invalid_json',
        provider: 'test-provider',
        model: 'test-model',
        message: '[testProvider] invalid json: no valid JSON found',
        raw_output: 'not json',
      });
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
    await assert.rejects(
      () => runWaterfallForSchemaFailureTest({
        prompt: 'Return ok JSON.',
        schema,
        stage: 'qa',
        schemaName: 'QaVerdictSchema',
        evidence,
        maxAttempts: 1,
        tiers: [{ name: 'test-tier', runner }],
      }),
      /All 1 runner\(s\) in the waterfall failed/,
    );

    const ledger = readJsonl(join(evidence.runDir, SCHEMA_FAILURE_LEDGER_FILENAME));
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0]?.['retry_outcome'], 'cascaded');
    assert.equal(ledger[0]?.['failure_kind'], 'invalid_json');
    assert.equal(ledger[1]?.['retry_outcome'], 'fatal');
    assert.deepEqual(ledger[1]?.['recovered_schema_failure_entry_ids'], [ledger[0]?.['entry_id']]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
