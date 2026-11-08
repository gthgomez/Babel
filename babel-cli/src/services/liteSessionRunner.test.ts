import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { runLiteSessionWithSchemaRecovery } from './liteSessionRunner.js';
import { baseReadOnlyLitePayload } from '../agent/contracts.js';
import { ProviderHttpError } from '../runners/providerHttpError.js';
import { StructuredOutputError } from '../runners/base.js';

test('schema fallback preserves an unverified draft without reporting provider success', async () => {
  let calls = 0;
  const payload = { ...baseReadOnlyLitePayload({ command: 'plan', task: 'fixture', project: null, runDir: null, projectRoot: null, status: 'PLAN_READY', userStatus: 'success', selectedLane: 'plan', executionPath: 'plan', next: [] }), execution_mode: 'offline_demo' as const };
  const result = await runLiteSessionWithSchemaRecovery(async () => {
    if (++calls === 1) throw new StructuredOutputError({ failure_kind: 'invalid_json', provider: 'openrouter', model: 'fixture', message: 'invalid JSON schema' });
    return { payload, exitCode: 0, planText: 'draft content' };
  }, { task: 'fixture', verb: 'plan' }, { verb: 'plan', selectedLane: 'lite_plan' });
  assert.equal(calls, 2);
  assert.equal(result.exitCode !== 0, true);
  assert.equal(result.payload.status, 'UNVERIFIED_LOCAL_DRAFT');
  assert.equal(result.payload.user_status, 'not_verified');
  assert.equal(result.payload.recovered_after_schema_retry, false);
  assert.equal((result.payload.usage as { costComplete?: boolean }).costComplete, false);
  assert.equal((result.payload.usage as { completeCostUSD?: number | null }).completeCostUSD, null);
  assert.equal(result.planText, 'draft content');
  assert.match(result.humanText ?? '', /unverified|not verified/i);
});

test('typed provider failures never trigger schema fallback', async () => {
  let calls = 0;
  await assert.rejects(runLiteSessionWithSchemaRecovery(async () => {
    calls++;
    throw new ProviderHttpError('openrouter', 'fixture', 401, 'response', null, 'schema authentication rejected');
  }, { task: 'fixture', verb: 'plan' }, { verb: 'plan', selectedLane: 'lite_plan' }), ProviderHttpError);
  assert.equal(calls, 1);
});

test('real local recovery writes a draft artifact that cannot be applied', async () => {
  const { readFileSync } = await import('node:fs');
  const { basename, join } = await import('node:path');
  const { loadPlanHandoff } = await import('../agent/planHandoff.js');
  const previous = process.env['BABEL_LITE_OFFLINE'];
  process.env['BABEL_LITE_OFFLINE'] = '1';
  try {
    let calls = 0;
    const result = await runLiteSessionWithSchemaRecovery(async session => {
      if (++calls === 1) throw new StructuredOutputError({ failure_kind: 'invalid_json', provider: 'openrouter', model: 'fixture', message: 'invalid JSON schema' });
      return session.run();
    }, { task: 'Inspect the project without modifications', verb: 'plan', projectRoot: process.cwd() },
    { verb: 'plan', selectedLane: 'lite_plan' });
    const runDir = result.payload['run_dir'];
    assert.equal(typeof runDir, 'string');
    const manifest = JSON.parse(readFileSync(join(runDir as string, 'manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'UNVERIFIED_LOCAL_DRAFT');
    assert.equal(loadPlanHandoff({ repoPath: process.cwd(), task: 'Apply', planRunId: basename(runDir as string) }), null);
    assert.equal(result.exitCode, 1);
    assert.ok(result.planText);
  } finally {
    if (previous === undefined) delete process.env['BABEL_LITE_OFFLINE']; else process.env['BABEL_LITE_OFFLINE'] = previous;
  }
});

test('configuration parse failures do not trigger diagnostic provider recovery', async () => {
  let calls = 0
  await assert.rejects(runLiteSessionWithSchemaRecovery(async () => {
    calls++; throw new Error('cannot parse local configuration')
  }, { task: 'fixture', verb: 'plan' }, { verb: 'plan', selectedLane: 'lite_plan' }), /configuration/)
  assert.equal(calls, 1)
})
