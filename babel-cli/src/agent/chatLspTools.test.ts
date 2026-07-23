import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ChatToolActionSchema,
  mapChatLspActionToToolRequest,
} from './chatToolDefinitions.js';

describe('mapChatLspActionToToolRequest', () => {
  it('maps goToDefinition with position fields', () => {
    const req = mapChatLspActionToToolRequest({
      type: 'lsp',
      operation: 'goToDefinition',
      filePath: 'src/index.ts',
      line: 10,
      character: 4,
    });
    assert.deepEqual(req, {
      tool: 'lsp',
      operation: 'goToDefinition',
      filePath: 'src/index.ts',
      line: 10,
      character: 4,
    });
  });

  it('maps workspaceSymbol with query and omits unused fields', () => {
    const req = mapChatLspActionToToolRequest({
      type: 'lsp',
      operation: 'workspaceSymbol',
      filePath: 'src/index.ts',
      query: 'ChatEngine',
    });
    assert.deepEqual(req, {
      tool: 'lsp',
      operation: 'workspaceSymbol',
      filePath: 'src/index.ts',
      query: 'ChatEngine',
    });
  });

  it('accepts call-hierarchy operations in ChatToolActionSchema', () => {
    const parsed = ChatToolActionSchema.parse({
      type: 'lsp',
      operation: 'incomingCalls',
      filePath: 'src/agent/chatEngine.ts',
      line: 100,
      character: 12,
    });
    assert.equal(parsed.type, 'lsp');
    if (parsed.type === 'lsp') {
      assert.equal(parsed.operation, 'incomingCalls');
    }
  });
});
