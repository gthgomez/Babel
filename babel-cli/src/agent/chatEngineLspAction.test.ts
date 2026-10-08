import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskOperation } from '../config/chatTaskClass.js';
import type { ChatEngineActionExecutorHost } from './chatEngineContracts.js';
import { executeChatLspAction } from './chatEngineLspAction.js';

for (const hostFallbackAllowed of [false, true]) {
  for (const acceptedOperation of [undefined, 'READ_ONLY', 'MUTATING', 'HYBRID'] as const) {
    test(`LSP action denies before dispatch: fallback=${hostFallbackAllowed}, operation=${acceptedOperation}`, async () => {
      const log: ChatEngineActionExecutorHost['toolCallLog'] = [];
      let dispatches = 0;
      let ownershipChecks = 0;
      const host = {
        isolationBrokerFlags: () => ({ hostFallbackAllowed }),
        toolCallLog: log,
        persistToolStartedAtExecutorDispatch: () => { dispatches++; },
        isSubmissionCurrent: () => { ownershipChecks++; return true; },
      } as unknown as ChatEngineActionExecutorHost;
      const completions: unknown[][] = [];
      const result = await executeChatLspAction({
        host,
        action: { type: 'lsp', operation: 'workspaceSymbol', filePath: 'src/index.ts', query: 'entry' },
        toolContext: { agentId: 'test', runId: 'test', runDir: '.', babelRoot: '.' },
        callbacks: { onToolComplete: (...values) => { completions.push(values); } },
        meta: { index: 7, ownerGeneration: 3 },
        ownerGeneration: 3,
        ...(acceptedOperation !== undefined ? { acceptedOperation: acceptedOperation as TaskOperation } : {}),
        tool: 'lsp', target: 'src/index.ts', toolId: 42,
      });
      const detail = 'LSP denied: Chat has no lease-governed language-server process adapter.';
      assert.deepEqual(result, { index: 7, observation: detail });
      assert.deepEqual(log, [{ tool: 'lsp', target: 'src/index.ts', detail, error: 'blocked', index: 7, exit_code: 1 }]);
      assert.deepEqual(completions, [[42, detail, detail, 1]]);
      assert.equal(dispatches, 0);
      assert.equal(ownershipChecks, 0, 'denied LSP never crosses the asynchronous dispatch boundary');
    });
  }
}
