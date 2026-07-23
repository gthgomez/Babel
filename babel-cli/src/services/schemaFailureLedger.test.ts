import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EvidenceBundle } from '../evidence.js';
import {
  SCHEMA_FAILURE_LEDGER_FILENAME,
  appendSchemaFailureEntry,
  appendSchemaFailureRecovery,
  getSchemaFailureStorageMode,
  readSchemaShadowHints,
} from './schemaFailureLedger.js';

function tempEvidence(): { root: string; evidence: EvidenceBundle; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'babel-schema-ledger-'));
  const evidence = new EvidenceBundle('schema ledger test', root);
  return {
    root,
    evidence,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function readLedger(runDir: string): Array<Record<string, unknown>> {
  return readFileSync(join(runDir, SCHEMA_FAILURE_LEDGER_FILENAME), 'utf-8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('schema failure ledger stores raw local artifacts and shadow hints by default', () => {
  const previous = process.env['BABEL_SCHEMA_FAILURE_STORAGE'];
  delete process.env['BABEL_SCHEMA_FAILURE_STORAGE'];
  const { evidence, cleanup } = tempEvidence();
  try {
    const error = Object.assign(
      new Error(
        '[deepSeekApi] Zod validation failed (deepseek-v4-flash): swarm.sub_tasks too small',
      ),
      {
        structuredOutputFailure: true,
        failure_kind: 'zod_validation_failed',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        raw_output: '{"swarm":{"parent_run_id":"r1","sub_tasks":[]}}',
        parsed_json: { swarm: { parent_run_id: 'r1', sub_tasks: [] } },
        zod_issues: [
          {
            path: ['swarm', 'sub_tasks'],
            code: 'too_small',
            message: 'Array must contain at least 1 element(s)',
          },
        ],
      },
    );

    const entry = appendSchemaFailureEntry({
      evidence,
      stage: 'orchestrator',
      schemaName: 'OrchestratorManifestSchema',
      tierName: 'DeepSeek v4 Flash',
      tierIndex: 0,
      attempt: 1,
      prompt: 'Return manifest JSON.',
      error,
      metadata: {
        provider: 'deepseek',
        provider_model_id: 'deepseek-v4-flash',
        latency_ms: 12,
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        estimated_cost_usd: 0.001,
      },
      retryOutcome: 'pending_retry',
      retryPrompt: 'Retry prompt',
    });

    assert.equal(getSchemaFailureStorageMode(), 'raw_local');
    assert.equal(entry.failure_kind, 'zod_validation_failed');
    assert.match(entry.recommended_next_action, /Omit swarm/);
    assert.ok(entry.raw_output_path);
    assert.ok(entry.parsed_output_path);
    assert.ok(entry.retry_prompt_path);
    assert.deepEqual(entry.zod_issues[0]?.path, ['swarm', 'sub_tasks']);

    const ledger = readLedger(evidence.runDir);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.['entry_id'], entry.entry_id);

    const hints = readSchemaShadowHints({
      evidence,
      stage: 'orchestrator',
      schemaName: 'OrchestratorManifestSchema',
    });
    assert.equal(hints.length, 1);
    assert.match(hints[0] ?? '', /Omit swarm/);
  } finally {
    if (previous === undefined) {
      delete process.env['BABEL_SCHEMA_FAILURE_STORAGE'];
    } else {
      process.env['BABEL_SCHEMA_FAILURE_STORAGE'] = previous;
    }
    cleanup();
  }
});

test('schema failure ledger redacted mode keeps hashes without raw side artifacts', () => {
  const previous = process.env['BABEL_SCHEMA_FAILURE_STORAGE'];
  process.env['BABEL_SCHEMA_FAILURE_STORAGE'] = 'redacted';
  const { evidence, cleanup } = tempEvidence();
  try {
    const error = Object.assign(new Error('[deepInfraApi] invalid json (model): no valid JSON'), {
      structuredOutputFailure: true,
      failure_kind: 'invalid_json',
      provider: 'deepinfra',
      model: 'model',
      raw_output: 'not json',
    });

    const entry = appendSchemaFailureEntry({
      evidence,
      stage: 'qa',
      schemaName: 'QaVerdictSchema',
      tierName: 'model',
      tierIndex: 0,
      attempt: 1,
      prompt: 'Return QA JSON.',
      error,
      metadata: null,
      retryOutcome: 'cascaded',
      retryPrompt: 'Retry prompt',
    });

    assert.equal(getSchemaFailureStorageMode(), 'redacted');
    assert.equal(entry.raw_output_path, null);
    assert.ok(entry.raw_output_sha256);
    assert.equal(entry.retry_prompt_path, null);
    assert.equal(readLedger(evidence.runDir).length, 1);
  } finally {
    if (previous === undefined) {
      delete process.env['BABEL_SCHEMA_FAILURE_STORAGE'];
    } else {
      process.env['BABEL_SCHEMA_FAILURE_STORAGE'] = previous;
    }
    cleanup();
  }
});

test('schema failure recovery appends an immutable recovered event', () => {
  const { evidence, cleanup } = tempEvidence();
  try {
    const recovery = appendSchemaFailureRecovery({
      evidence,
      stage: 'executor',
      schemaName: 'ExecutorTurnSchema',
      tierName: 'DeepSeek v4 Flash',
      tierIndex: 0,
      attempt: 2,
      prompt: 'Retry executor JSON.',
      metadata: null,
      recoveredEntryIds: ['schema_failure_1'],
    });

    assert.equal(recovery.retry_outcome, 'recovered');
    assert.deepEqual(recovery.recovered_schema_failure_entry_ids, ['schema_failure_1']);
    assert.equal(readLedger(evidence.runDir).length, 1);
  } finally {
    cleanup();
  }
});
