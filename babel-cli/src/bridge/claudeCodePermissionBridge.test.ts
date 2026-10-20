import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bridgeClaudeCanUseTool } from './claudeCodePermissionBridge.js';
import { RemoteApprovalBroker } from './remoteApproval.js';

describe('claudeCodePermissionBridge', () => {
  it('denies unknown tool representation without broker pending', async () => {
    const broker = new RemoteApprovalBroker();
    const decision = await bridgeClaudeCanUseTool({
      req: { toolName: 'WarpDrive', input: {} },
      cwd: '/tmp',
      threadId: 't1',
      turnId: 'turn-1',
      broker,
      generation: 1,
      activeGeneration: () => 1,
    });
    assert.equal(decision.behavior, 'deny');
    assert.match(decision.message ?? '', /unknown_tool_representation/);
    assert.equal(broker.listPending('t1').length, 0);
  });

  it('fails closed on stale generation after approval wait', async () => {
    const broker = new RemoteApprovalBroker();
    let gen = 1;
    const pending = broker.createPending({
      thread_id: 't1',
      turn_id: 'turn-1',
      operation: {
        action_type: 'read_file',
        command: '',
        canonical_cwd: '/tmp',
        target_path: '/tmp/a',
        thread_id: 't1',
        turn_id: 'turn-1',
      },
    });
    gen = 2;
    const decision = await bridgeClaudeCanUseTool({
      req: { toolName: 'Read', input: { path: '/tmp/a' } },
      cwd: '/tmp',
      threadId: 't1',
      turnId: 'turn-1',
      broker,
      generation: 1,
      activeGeneration: () => gen,
    });
    assert.equal(decision.behavior, 'deny');
    void pending;
  });
});
