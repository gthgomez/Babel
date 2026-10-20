import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { SessionDescriptor } from '../executor/contracts.js';
import { RemoteApprovalBroker, runOnRemoteSurface } from './remoteApproval.js';
import { CommandCodeAcpRuntimeRegistry } from './commandCodeAcpRuntime.js';
import { createOpenCodeHarnessEngine } from './openCodeHarnessEngine.js';
import { OpenCodeAcpRuntimeRegistry } from './openCodeAcpRuntime.js';

const HANG_PEER = fileURLToPath(
  new URL('../../test/fixtures/opencode-acp-prompt-hang-peer.mjs', import.meta.url),
);
const CC_PEER = fileURLToPath(
  new URL('../../test/fixtures/command-code-acp-peer.mjs', import.meta.url),
);

function harnessDescriptor(
  threadId: string,
  projectRoot: string,
  adapter: 'opencode' | 'command-code',
): SessionDescriptor {
  return {
    schemaVersion: 1,
    threadId,
    projectRoot,
    mode: 'chat',
    provider: 'default',
    model: 'default',
    policyProfile: 'safe_repo',
    createdAt: new Date().toISOString(),
    kernelVersion: 'executor-kernel-v1',
    contractVersion: 'executor-contract-v1',
    harness_adapter_id: adapter,
  };
}

describe('openCodeHarnessEngine prompt timeout death fence', () => {
  let tmp: string;
  let registry: OpenCodeAcpRuntimeRegistry;
  let ccRegistry: CommandCodeAcpRuntimeRegistry;

  after(async () => {
    await registry?.closeAll();
    await ccRegistry?.closeAll();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('waits for owned process death after shared RPC timeout before terminal failed', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-opencode-death-fence-'));
    registry = new OpenCodeAcpRuntimeRegistry({
      testLaunch: { command: process.execPath, args: [HANG_PEER] },
      testRpcTimeoutMs: 80,
      installProbe: async () => ({
        state: 'verified',
        executable: process.execPath,
        version: 'fixture',
      }),
    });
    ccRegistry = new CommandCodeAcpRuntimeRegistry({
      testLaunch: { command: process.execPath, args: [CC_PEER] },
      installProbe: async () => ({
        state: 'verified',
        executable: process.execPath,
        version: 'fixture',
      }),
    });

    const descriptor = harnessDescriptor('thread-opencode-death', tmp, 'opencode');

    const ccDescriptor = harnessDescriptor('thread-cc-isolation', tmp, 'command-code');
    const ccSession = await ccRegistry.ensureSession(ccDescriptor);
    assert.equal(ccSession.processDead, false);

    const engine = createOpenCodeHarnessEngine({ descriptor, registry });
    const broker = new RemoteApprovalBroker();
    const session = await registry.ensureSession(descriptor);
    assert.equal(session.processDead, false);

    const started = Date.now();
    const events = await runOnRemoteSurface(
      {
        broker,
        threadId: descriptor.threadId,
        turnId: 'turn-1',
        failClosedMcp: true,
        cwd: tmp,
      },
      async () => {
        const collected = [];
        for await (const event of engine.submitMessageStream('hang')) {
          collected.push(event);
          if (event.type === 'failed') break;
        }
        return collected;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 100, `expected to wait for slow child exit, elapsed=${elapsed}ms`);
    assert.equal(events.at(-1)?.type, 'failed');
    assert.equal(session.processDead, true);

    assert.equal(ccSession.processDead, false);
  });
});
