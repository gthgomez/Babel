import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BABEL_RUNTIME_PROTOCOL_VERSION,
  buildRuntimeProtocolContract,
  makeRuntimeEvent,
} from './protocol.js';

test('runtime protocol v1 contract exposes stable event fields', () => {
  const contract = buildRuntimeProtocolContract();
  assert.equal(contract.protocol_id, 'babel.runtime.v1');
  assert.equal(contract.protocol_version, 1);
  assert.equal(contract.event_types.includes('policy.decision'), true);
  assert.equal(contract.event_types.includes('verification.decision'), true);
  assert.equal(contract.required_event_fields.includes('payload'), true);
});

test('runtime protocol event is machine-readable', () => {
  const event = makeRuntimeEvent('tool.requested', { tool: 'file_read' });
  assert.equal(event.protocol_version, BABEL_RUNTIME_PROTOCOL_VERSION);
  assert.equal(event.event_type, 'tool.requested');
  assert.deepEqual(event.payload, { tool: 'file_read' });
});
