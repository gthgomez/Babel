import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SessionDescriptor } from '../executor/contracts.js';
import { CommandCodeAcpRuntimeRegistry } from './commandCodeAcpRuntime.js';

describe('commandCodeAcpRuntime ensureSession init', () => {
  it('does not leave unhandledRejection when initialization fails', async () => {
    const registry = new CommandCodeAcpRuntimeRegistry();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    const descriptor = {
      threadId: 'thread-unsupported',
      projectRoot: process.cwd(),
      harness_adapter_id: 'babel-native',
    } as SessionDescriptor;
    await assert.rejects(() => registry.ensureSession(descriptor), /COMMAND_CODE_SESSION_ADAPTER_MISMATCH/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', onRejection);
    assert.equal(rejections.length, 0);
  });
});
