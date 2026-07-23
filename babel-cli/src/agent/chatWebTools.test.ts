import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapChatWebActionToToolRequest } from './chatToolDefinitions.js';

describe('mapChatWebActionToToolRequest', () => {
  it('maps web_search to ToolCallRequest', () => {
    const req = mapChatWebActionToToolRequest({
      type: 'web_search',
      query: 'babel cli tui',
    });
    assert.deepEqual(req, { tool: 'web_search', query: 'babel cli tui' });
  });

  it('maps web_fetch to ToolCallRequest', () => {
    const req = mapChatWebActionToToolRequest({
      type: 'web_fetch',
      url: 'https://example.com/docs',
    });
    assert.deepEqual(req, { tool: 'web_fetch', url: 'https://example.com/docs' });
  });

  it('throws for non-web actions', () => {
    assert.throws(
      () =>
        mapChatWebActionToToolRequest({
          type: 'read_file',
          path: 'src/index.ts',
        }),
      /Not a web action/,
    );
  });
});