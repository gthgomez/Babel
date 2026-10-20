import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ANTIGRAVITY_DISABLED_CAPABILITIES,
  ANTIGRAVITY_UNSUPPORTED_REASON,
  buildAntigravityAdapterDescriptor,
} from './antigravityOwnCliAdapter.js';

describe('antigravityOwnCliAdapter', () => {
  it('keeps all harness capabilities disabled with a static offline foundation reason', () => {
    const descriptor = buildAntigravityAdapterDescriptor();
    assert.equal(descriptor.id, 'antigravity');
    assert.equal(descriptor.version, 'offline-foundation');
    assert.deepEqual(descriptor.capabilities, ANTIGRAVITY_DISABLED_CAPABILITIES);
    assert.equal(descriptor.capabilities.start, false);
    assert.equal(descriptor.capabilities.approve, false);
    assert.equal(descriptor.capabilities.attachLive, false);
    assert.equal(descriptor.unsupportedReason, ANTIGRAVITY_UNSUPPORTED_REASON);
    assert.match(descriptor.unsupportedReason ?? '', /offline evidence foundation/i);
    assert.match(descriptor.unsupportedReason ?? '', /attachLive=false/i);
  });
});
