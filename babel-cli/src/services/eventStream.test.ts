import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BabelEventBus } from '../pipeline.js';
import { buildEventStreamContract, createJsonEventStream } from './eventStream.js';

test('event stream contract is read-only and schema-versioned for bridge consumers', () => {
  const contract = buildEventStreamContract();

  assert.equal(contract.contract_id, 'babel.event_stream');
  assert.equal(contract.event_schema_version, 3);
  assert.equal(contract.format, 'jsonl');
  assert.equal(contract.read_only, true);
  assert.equal(contract.bridge_policy.mutates_workspace, false);
  assert.equal(contract.bridge_policy.mutates_git, false);
  assert.equal(contract.bridge_policy.remote_side_effects, false);
  assert.equal(contract.bridge_policy.approval_actions, 'not_supported');
  assert.equal(contract.event_types.includes('babel.run.result'), true);
  assert.equal(contract.event_types.includes('babel.runtime.event'), true);
  assert.deepEqual(contract.payload_contracts['babel.stage.changed'], ['stage']);
  assert.deepEqual(contract.payload_contracts['babel.runtime.event'], ['protocol_version', 'event_type', 'payload']);
});

test('JSON event stream records bus events as JSONL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-event-stream-'));
  const bus = new BabelEventBus();
  const stream = createJsonEventStream(join(dir, 'events.jsonl'), { bus, runLabel: 'test-run' });

  bus.stage(2);
  bus.agentId('QA');
  bus.runtimeEvent('policy.decision', { decision: 'allow' });
  bus.logLine('hello');
  stream.close({ status: 'COMPLETE' });

  const events = readFileSync(stream.path, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.deepEqual(events.map((event) => event.event), [
    'babel.stream.started',
    'babel.stage.changed',
    'babel.agent.changed',
    'babel.runtime.event',
    'babel.log.line',
    'babel.stream.ended',
  ]);
  assert.equal(events[0]?.schema_version, 3);
  assert.equal(events[1]?.sequence, 2);
  assert.deepEqual(events[1]?.payload, { stage: 2 });
  assert.deepEqual(events[3]?.payload, {
    protocol_version: 1,
    event_type: 'policy.decision',
    payload: { decision: 'allow' },
  });
  assert.deepEqual(events[5]?.payload, { status: 'COMPLETE' });
});
