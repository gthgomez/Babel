import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
  assert.equal(contract.bridge_policy.host_mode, 'enhanced_repl');
  assert.equal(contract.bridge_policy.approval_actions, 'session_only');
  assert.match(contract.bridge_policy.approval_semantics, /interactive REPL/);
  assert.equal(contract.event_types.includes('babel.assistant.chunk'), true);
  assert.equal(contract.event_types.includes('babel.run.result'), true);
  assert.equal(contract.event_types.includes('babel.runtime.event'), true);
  assert.deepEqual(contract.payload_contracts['babel.stage.changed'], ['stage']);
  assert.deepEqual(contract.payload_contracts['babel.runtime.event'], [
    'protocol_version',
    'event_type',
    'payload',
  ]);
});

test('JSON event stream records bus events as JSONL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-event-stream-'));
  const bus = new BabelEventBus();
  const stream = createJsonEventStream(join(dir, 'events.jsonl'), { bus, runLabel: 'test-run' });

  bus.stage(2);
  bus.agentId('QA');
  bus.assistantChunk('Hel', 1);
  bus.assistantChunk('lo', 1);
  bus.runtimeEvent('policy.decision', { decision: 'allow' });
  bus.logLine('hello');
  await stream.close({ status: 'COMPLETE' });

  const content = await readFile(stream.path, 'utf8');
  const events = content
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.deepEqual(
    events.map((event) => event.event),
    [
      'babel.stream.started',
      'babel.stage.changed',
      'babel.agent.changed',
      'babel.assistant.chunk',
      'babel.assistant.chunk',
      'babel.runtime.event',
      'babel.log.line',
      'babel.stream.ended',
    ],
  );
  assert.equal(events[0]?.schema_version, 3);
  assert.equal(events[1]?.sequence, 2);
  assert.deepEqual(events[1]?.payload, { stage: 2 });
  assert.deepEqual(events[3]?.payload, { chunk: 'Hel', turn_id: 1 });
  assert.deepEqual(events[4]?.payload, { chunk: 'lo', turn_id: 1 });
  assert.deepEqual(events[5]?.payload, {
    protocol_version: 1,
    event_type: 'policy.decision',
    payload: { decision: 'allow' },
  });
  assert.deepEqual(events[7]?.payload, { status: 'COMPLETE' });
});
