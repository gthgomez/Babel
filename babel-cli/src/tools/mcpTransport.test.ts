import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMcpToolSearchPayload,
  buildMcpToolCallParams,
  frameJsonRpcMessage,
  parseFramedMessages,
} from './mcpTransport.js';

test('parseFramedMessages parses one complete JSON-RPC frame', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  const framed = frameJsonRpcMessage(body);

  const parsed = parseFramedMessages(Buffer.from(framed, 'utf8'));

  assert.equal(parsed.messages.length, 1);
  assert.deepEqual(parsed.messages[0], { jsonrpc: '2.0', id: 1, result: { ok: true } });
  assert.equal(parsed.remainder.length, 0);
});

test('parseFramedMessages leaves partial frames in the remainder', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'pending' });
  const framed = frameJsonRpcMessage(body);
  const partial = framed.slice(0, framed.length - 3);

  const parsed = parseFramedMessages(Buffer.from(partial, 'utf8'));

  assert.equal(parsed.messages.length, 0);
  assert.equal(parsed.remainder.toString('utf8'), partial);
});

test('buildMcpToolCallParams prefers query-like schema fields', () => {
  const params = buildMcpToolCallParams([
    {
      name: 'search',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
      },
    },
  ], 'find this');

  assert.deepEqual(params, {
    name: 'search',
    arguments: { query: 'find this' },
  });
});

test('buildMcpToolCallParams defaults to text argument when schema is opaque', () => {
  const params = buildMcpToolCallParams([{ name: 'lookup' }], 'hello');

  assert.deepEqual(params, {
    name: 'lookup',
    arguments: { text: 'hello' },
  });
});

test('buildMcpToolSearchPayload filters tools and bounds schemas', () => {
  const payload = buildMcpToolSearchPayload([
    {
      name: 'issue_search',
      description: 'Search issues',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    },
    {
      name: 'pull_request_get',
      description: 'Fetch PRs',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    },
  ], 'issue', 10, 0);

  const contentPolicy = payload.content_policy as Record<string, unknown>;
  assert.equal(contentPolicy.untrusted_external_content, true);
  assert.match(String(contentPolicy.prompt_injection_label), /UNTRUSTED_MCP_CONTENT/);
  assert.equal(payload.total_matched, 1);
  assert.deepEqual(payload.tools, [{
    name: 'issue_search',
    description: 'Search issues',
    inputSchema_omitted: true,
  }]);
});
