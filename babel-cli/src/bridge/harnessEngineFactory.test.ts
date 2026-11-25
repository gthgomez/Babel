import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SessionDescriptor } from '../executor/contracts.js';
import type { CommandCodeAcpRuntimeRegistry } from './commandCodeAcpRuntime.js';
import type { OpenCodeAcpRuntimeRegistry } from './openCodeAcpRuntime.js';
import { createHarnessAwareEngineFactory } from './harnessEngineFactory.js';

describe('createHarnessAwareEngineFactory', () => {
  it('rejects an unknown adapter before selecting the native engine', () => {
    const factory = createHarnessAwareEngineFactory(
      {} as CommandCodeAcpRuntimeRegistry,
      {} as OpenCodeAcpRuntimeRegistry,
    );
    const descriptor = {
      schemaVersion: 1,
      threadId: 'thread-unknown-adapter',
      projectRoot: process.cwd(),
      mode: 'chat',
      provider: 'default',
      model: 'default',
      policyProfile: 'safe_repo',
      createdAt: new Date(0).toISOString(),
      kernelVersion: 'executor-kernel-v1',
      contractVersion: 'executor-contract-v1',
      harness_adapter_id: 'unknown-adapter',
    } as unknown as SessionDescriptor;

    assert.throws(
      () => factory(descriptor),
      /UNSUPPORTED_HARNESS_ADAPTER_ID/,
    );
  });
});
