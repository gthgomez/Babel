import test from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import {
  assessMcpToolCallPayload,
  buildMcpToolSearchPayload,
  buildMcpToolCallParams,
  frameJsonRpcMessage,
  executeMcpMethod,
  handleMcpRequest,
  handleMcpToolCall,
  parseMcpToolCallResult,
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
  const params = buildMcpToolCallParams(
    [
      {
        name: 'search',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
        },
      },
    ],
    'find this',
  );

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
  const payload = buildMcpToolSearchPayload(
    [
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
    ],
    'issue',
    10,
    0,
  );

  const contentPolicy = payload.content_policy as Record<string, unknown>;
  assert.equal(contentPolicy.untrusted_external_content, true);
  assert.match(String(contentPolicy.prompt_injection_label), /UNTRUSTED_MCP_CONTENT/);
  assert.equal(payload.total_matched, 1);
  assert.deepEqual(payload.tools, [
    {
      name: 'issue_search',
      description: 'Search issues',
      inputSchema_omitted: true,
    },
  ]);
});
test('MCP tool result rejects malformed response envelopes as typed failures', () => {
  const result = parseMcpToolCallResult(
    { exit_code: 0, stdout: JSON.stringify({ status: 'success', result: {} }), stderr: '' },
    'lookup',
  );

  assert.equal(result.exit_code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.failure?.code, 'invalid_mcp_tool_result');
  assert.equal(result.render_intent, 'tool_failure');
});

test('MCP tool result rejects empty and non-text successful content', () => {
  for (const content of [[], [{ type: 'image', data: 'opaque' }]]) {
    const result = parseMcpToolCallResult(
      {
        exit_code: 0,
        stdout: JSON.stringify({ status: 'success', result: { content } }),
        stderr: '',
      },
      'lookup',
    );

    assert.equal(result.exit_code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.failure?.code, 'invalid_mcp_tool_result');
    assert.equal(result.render_intent, 'tool_failure');
  }
});
test('MCP tool result preserves valid text output with explicit render intent', () => {
  const result = parseMcpToolCallResult(
    {
      exit_code: 0,
      stdout: JSON.stringify({
        status: 'success',
        result: { content: [{ type: 'text', text: 'safe result' }] },
      }),
      stderr: '',
    },
    'lookup',
  );

  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, 'safe result');
  assert.equal(result.render_intent, 'mcp_result');
});
test('generic MCP request rejects a malformed live tools/call result without echoing it', async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'babel-mcp-invalid-result-'));
  const serverPath = join(fixtureDir, 'server.cjs');
  const sentinel = 'MCP_SECRET_SENTINEL';
  const fixture = [
    "let input = ''; let initialized = false; let listed = false; let called = false;",
    "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
    "function send(value) { process.stdout.write(frame(value)); }",
    "process.stdin.on('data', (chunk) => {",
    "  input += chunk.toString();",
    "  if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; send({ jsonrpc: '2.0', id: 0, result: {} }); }",
    "  if (!listed && input.includes('\\\"id\\\":1')) { listed = true; send({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] } }); }",
    "  if (!called && input.includes('\\\"id\\\":2')) { called = true; send({ jsonrpc: '2.0', id: 2, result: { leaked: 'MCP_SECRET_SENTINEL' } }); }",
    "});",
  ].join('\n');

  try {
    writeFileSync(serverPath, fixture, 'utf8');
    const result = await handleMcpRequest(
      { tool: 'mcp_request', server: 'fixture', query: 'find it' },
      { fixture: { command: 'node', args: [serverPath] } },
    );

    assert.equal(result.exit_code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.mcp_lifecycle?.reason_code, 'invalid_mcp_tool_result');
    assert.match(result.stderr, /MCP_RESULT_INVALID/);
    assert.doesNotMatch(result.stderr, new RegExp(sentinel));
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
test('generic MCP resource, prompt, and tool-list calls reject malformed live results', async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'babel-mcp-invalid-generic-'));
  const serverPath = join(fixtureDir, 'server.cjs');
  const sentinel = 'MCP_GENERIC_SECRET_SENTINEL';
  const fixture = [
    "let input = ''; let initialized = false; let replied = false;",
    "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
    "function send(value) { process.stdout.write(frame(value)); }",
    "process.stdin.on('data', (chunk) => {",
    "  input += chunk.toString();",
    "  if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; send({ jsonrpc: '2.0', id: 0, result: {} }); }",
    "  if (!replied && input.includes('\\\"id\\\":1')) { replied = true; send({ jsonrpc: '2.0', id: 1, result: { leaked: 'MCP_GENERIC_SECRET_SENTINEL' } }); }",
    "});",
  ].join('\n');
  const servers = { fixture: { command: 'node', args: [serverPath] } };

  try {
    writeFileSync(serverPath, fixture, 'utf8');
    for (const method of ['resources/list', 'prompts/list', 'tools/list']) {
      const result = await executeMcpMethod('fixture', method, undefined, undefined, servers);
      assert.equal(result.exit_code, 1, method);
      assert.equal(result.stdout, '', method);
      assert.equal(result.failure?.code, 'invalid_mcp_tool_result', method);
      assert.equal(result.render_intent, 'tool_failure', method);
      assert.equal(result.mcp_lifecycle?.reason_code, 'invalid_mcp_tool_result', method);
      assert.doesNotMatch(result.stderr, new RegExp(sentinel), method);
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('MCP tool payload classifier rejects literal-null and malformed result values', () => {
  assert.deepEqual(assessMcpToolCallPayload(null), { kind: 'invalid' });
  assert.deepEqual(assessMcpToolCallPayload({ content: 'not-an-array' }), { kind: 'invalid' });
});

test('MCP tool result parser turns literal-null and malformed raw envelopes into nonleaking failures', () => {
  for (const stdout of ['null', '[]', JSON.stringify({ status: 'success', result: null }), JSON.stringify({ status: 'failure', result: null })]) {
    const result = parseMcpToolCallResult({ exit_code: 0, stdout, stderr: '' }, 'lookup');

    assert.equal(result.exit_code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.failure?.code, 'invalid_mcp_tool_result');
    assert.equal(result.render_intent, 'tool_failure');
    assert.equal(result.mcp_lifecycle?.outcome, 'failure');
    assert.equal(result.mcp_lifecycle?.reason_code, 'invalid_mcp_tool_result');
  }
});

test('MCP tool result parser converts tool-level errors into typed nonleaking lifecycle failures', () => {
  const sentinel = 'MCP_TOOL_ERROR_SECRET';
  const result = parseMcpToolCallResult(
    {
      exit_code: 0,
      stdout: JSON.stringify({
        status: 'success',
        result: { content: [{ type: 'text', text: sentinel }], isError: true },
      }),
      stderr: '',
      mcp_lifecycle: {
        server: 'fixture',
        phase: 'complete',
        outcome: 'success',
        reason_code: 'response_received',
        evidence: ['method:tools/call'],
      },
    },
    'lookup',
  );

  assert.equal(result.exit_code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.failure?.code, 'mcp_tool_error');
  assert.equal(result.failure?.category, 'tool_execution');
  assert.equal(result.failure?.tool, 'mcp:lookup');
  assert.equal(result.mcp_lifecycle?.phase, 'response_parse');
  assert.equal(result.mcp_lifecycle?.outcome, 'failure');
  assert.equal(result.mcp_lifecycle?.reason_code, 'tool_error');
  assert.doesNotMatch(result.stderr, new RegExp(sentinel));
});

test('shared MCP transport rejects live tools/call errors without returning remote content', async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'babel-mcp-tool-error-transport-'));
  const serverPath = join(fixtureDir, 'server.cjs');
  const sentinel = 'MCP_TRANSPORT_TOOL_ERROR_SECRET';
  const fixture = [
    "let input = ''; let initialized = false; let replied = false;",
    "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
    "function send(value) { process.stdout.write(frame(value)); }",
    "process.stdin.on('data', (chunk) => {",
    "  input += chunk.toString();",
    "  if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; send({ jsonrpc: '2.0', id: 0, result: {} }); }",
    "  if (!replied && input.includes('\\\"id\\\":1')) { replied = true; send({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'MCP_TRANSPORT_TOOL_ERROR_SECRET' }], isError: true } }); }",
    "});",
  ].join('\n');

  try {
    writeFileSync(serverPath, fixture, 'utf8');
    const result = await executeMcpMethod(
      'fixture',
      'tools/call',
      { name: 'lookup', arguments: { query: 'find it' } },
      undefined,
      { fixture: { command: 'node', args: [serverPath] } },
    );

    assert.equal(result.exit_code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.failure?.code, 'mcp_tool_error');
    assert.equal(result.failure?.tool, 'mcp:tools/call');
    assert.equal(result.mcp_lifecycle?.outcome, 'failure');
    assert.equal(result.mcp_lifecycle?.reason_code, 'tool_error');
    assert.doesNotMatch(result.stderr, new RegExp(sentinel));
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('generic MCP request rejects live tool-level errors without returning remote content', async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'babel-mcp-tool-error-request-'));
  const serverPath = join(fixtureDir, 'server.cjs');
  const sentinel = 'MCP_REQUEST_TOOL_ERROR_SECRET';
  const fixture = [
    "let input = ''; let initialized = false; let listed = false; let called = false;",
    "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
    "function send(value) { process.stdout.write(frame(value)); }",
    "process.stdin.on('data', (chunk) => {",
    "  input += chunk.toString();",
    "  if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; send({ jsonrpc: '2.0', id: 0, result: {} }); }",
    "  if (!listed && input.includes('\\\"id\\\":1')) { listed = true; send({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] } }); }",
    "  if (!called && input.includes('\\\"id\\\":2')) { called = true; send({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'MCP_REQUEST_TOOL_ERROR_SECRET' }], isError: true } }); }",
    "});",
  ].join('\n');

  try {
    writeFileSync(serverPath, fixture, 'utf8');
    const result = await handleMcpRequest(
      { tool: 'mcp_request', server: 'fixture', query: 'find it' },
      { fixture: { command: 'node', args: [serverPath] } },
    );

    assert.equal(result.exit_code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.failure?.code, 'mcp_tool_error');
    assert.equal(result.failure?.tool, 'mcp:tools/call');
    assert.equal(result.mcp_lifecycle?.outcome, 'failure');
    assert.equal(result.mcp_lifecycle?.reason_code, 'tool_error');
    assert.doesNotMatch(result.stderr, new RegExp(sentinel));
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('shared MCP tools/call rejects invalid outbound params before server dispatch', async () => {
  const result = await executeMcpMethod(
    'fixture',
    'tools/call',
    { name: '', arguments: {} },
    undefined,
    { fixture: { command: 'command-that-must-not-run', args: [] } },
  );

  assert.equal(result.exit_code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.mcp_lifecycle?.phase, 'write_request');
  assert.equal(result.mcp_lifecycle?.reason_code, 'invalid_request_payload');
  assert.match(result.stderr, /MCP_PAYLOAD_INVALID/);
});

test('shared MCP transport redacts id=1 JSON-RPC errors and suppresses child stderr', async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'babel-mcp-rpc-error-transport-'));
  const serverPath = join(fixtureDir, 'server.cjs');
  const rpcSentinel = 'MCP_RPC_ERROR_SENTINEL';
  const stderrSentinel = 'MCP_CHILD_STDERR_SENTINEL';
  const fixture = [
    "let input = ''; let initialized = false; let replied = false;",
    "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
    "function send(value) { process.stdout.write(frame(value)); }",
    "process.stdin.on('data', (chunk) => {",
    "  input += chunk.toString();",
    "  if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; process.stderr.write('MCP_CHILD_STDERR_SENTINEL'); send({ jsonrpc: '2.0', id: 0, result: {} }); }",
    "  if (!replied && input.includes('\\\"id\\\":1')) { replied = true; send({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'MCP_RPC_ERROR_SENTINEL', data: { secret: 'MCP_RPC_ERROR_SENTINEL' } } }); }",
    "});",
  ].join('\n');

  try {
    writeFileSync(serverPath, fixture, 'utf8');
    const result = await executeMcpMethod(
      'fixture',
      'tools/call',
      { name: 'lookup', arguments: { query: 'find it' } },
      undefined,
      { fixture: { command: 'node', args: [serverPath] } },
    );

    assert.equal(result.exit_code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.failure?.code, 'mcp_rpc_error');
    assert.equal(result.failure?.category, 'transport');
    assert.equal(result.failure?.tool, 'mcp:tools/call');
    assert.equal(result.mcp_lifecycle?.reason_code, 'rpc_error');
    assert.doesNotMatch(result.stderr, new RegExp(rpcSentinel));
    assert.doesNotMatch(result.stderr, new RegExp(stderrSentinel));
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('generic MCP request redacts id=1 and id=2 JSON-RPC errors', async () => {
  for (const failingId of [1, 2] as const) {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'babel-mcp-rpc-error-request-'));
    const serverPath = join(fixtureDir, 'server.cjs');
    const sentinel = `MCP_REQUEST_RPC_${failingId}_SENTINEL`;
    const fixture = failingId === 1
      ? [
          "let input = ''; let initialized = false; let replied = false;",
          "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
          "function send(value) { process.stdout.write(frame(value)); }",
          "process.stdin.on('data', (chunk) => {",
          "  input += chunk.toString();",
          "  if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; send({ jsonrpc: '2.0', id: 0, result: {} }); }",
          "  if (!replied && input.includes('\\\"id\\\":1')) { replied = true; send({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'MCP_REQUEST_RPC_1_SENTINEL', data: { secret: 'MCP_REQUEST_RPC_1_SENTINEL' } } }); }",
          "});",
        ].join('\n')
      : [
          "let input = ''; let initialized = false; let listed = false; let replied = false;",
          "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
          "function send(value) { process.stdout.write(frame(value)); }",
          "process.stdin.on('data', (chunk) => {",
          "  input += chunk.toString();",
          "  if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; send({ jsonrpc: '2.0', id: 0, result: {} }); }",
          "  if (!listed && input.includes('\\\"id\\\":1')) { listed = true; send({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] } }); }",
          "  if (!replied && input.includes('\\\"id\\\":2')) { replied = true; send({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'MCP_REQUEST_RPC_2_SENTINEL', data: { secret: 'MCP_REQUEST_RPC_2_SENTINEL' } } }); }",
          "});",
        ].join('\n');

    try {
      writeFileSync(serverPath, fixture, 'utf8');
      const result = await handleMcpRequest(
        { tool: 'mcp_request', server: 'fixture', query: 'find it' },
        { fixture: { command: 'node', args: [serverPath] } },
      );

      assert.equal(result.exit_code, 1, `id=${failingId}`);
      assert.equal(result.stdout, '', `id=${failingId}`);
      assert.equal(result.failure?.code, 'mcp_rpc_error', `id=${failingId}`);
      assert.equal(result.failure?.category, 'transport', `id=${failingId}`);
      assert.equal(result.failure?.tool, failingId === 1 ? 'mcp:tools/list' : 'mcp:tools/call');
      assert.equal(result.mcp_lifecycle?.reason_code, 'rpc_error', `id=${failingId}`);
      assert.doesNotMatch(result.stderr, new RegExp(sentinel), `id=${failingId}`);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
});

test('supported MCP methods reject invalid params before the server is spawned', async () => {
  const cases: Array<[string, Record<string, unknown> | undefined]> = [
    ['resources/read', {}],
    ['prompts/get', {}],
    ['tools/list', { unexpected: true }],
    ['resources/list', { unexpected: true }],
    ['prompts/list', { unexpected: true }],
  ];
  for (const [method, params] of cases) {
    const result = await executeMcpMethod(
      'fixture',
      method,
      params,
      undefined,
      { fixture: { command: 'command-that-must-not-run', args: [] } },
    );
    assert.equal(result.exit_code, 1, method);
    assert.equal(result.mcp_lifecycle?.phase, 'write_request', method);
    assert.equal(result.mcp_lifecycle?.reason_code, 'invalid_request_payload', method);
  }
});

test('MCP resource and prompt result schemas reject otherwise-valid unrecognized fields without leaks', async () => {
  for (const [method, result, sentinel] of [
    ['resources/read', { contents: [{ uri: 'file:///unsafe', text: 'safe resource', leaked: 'MCP_RESOURCE_CONTENT_SENTINEL' }] }, 'MCP_RESOURCE_CONTENT_SENTINEL'],
    ['resources/read', { contents: [{ uri: 'file:///unsafe', text: 'safe resource' }], leaked: 'MCP_RESOURCE_RESULT_SENTINEL' }, 'MCP_RESOURCE_RESULT_SENTINEL'],
    ['prompts/get', { messages: [{ role: 'user', content: { type: 'text', text: 'safe prompt' }, leaked: 'MCP_PROMPT_MESSAGE_SENTINEL' }] }, 'MCP_PROMPT_MESSAGE_SENTINEL'],
    ['prompts/get', { messages: [{ role: 'user', content: { type: 'text', text: 'safe prompt', leaked: 'MCP_PROMPT_CONTENT_SENTINEL' } }] }, 'MCP_PROMPT_CONTENT_SENTINEL'],
    ['prompts/get', { messages: [{ role: 'user', content: { type: 'text', text: 'safe prompt' } }], leaked: 'MCP_PROMPT_RESULT_SENTINEL' }, 'MCP_PROMPT_RESULT_SENTINEL'],
  ] as const) {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'babel-mcp-contract-result-'));
    const serverPath = join(fixtureDir, 'server.cjs');
    const fixture = [
      "let input = ''; let initialized = false; let replied = false;",
      "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
      "function send(value) { process.stdout.write(frame(value)); }",
      "process.stdin.on('data', (chunk) => {",
      "  input += chunk.toString();",
      "  if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; send({ jsonrpc: '2.0', id: 0, result: {} }); }",
      `  if (!replied && input.includes('\\"id\\":1')) { replied = true; send({ jsonrpc: '2.0', id: 1, result: ${JSON.stringify(result)} }); }`,
      "});",
    ].join('\n');
    try {
      writeFileSync(serverPath, fixture, 'utf8');
      const params = method === 'resources/read' ? { uri: 'file:///unsafe' } : { name: 'unsafe' };
      const response = await executeMcpMethod(
        'fixture',
        method,
        params,
        undefined,
        { fixture: { command: 'node', args: [serverPath] } },
      );
      assert.equal(response.exit_code, 1, method);
      assert.equal(response.failure?.code, 'invalid_mcp_tool_result', method);
      assert.equal(response.render_intent, 'tool_failure', method);
      assert.doesNotMatch(response.stderr, new RegExp(sentinel), method);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
});

test('MCP tool selector skips incompatible required schemas and uses a compatible fallback', () => {
  assert.deepEqual(
    buildMcpToolCallParams(
      [
        { name: 'query', inputSchema: { properties: { query: {} }, required: ['query', 'api_key'] } },
        { name: 'search', inputSchema: { properties: { text: {} }, required: ['text'] } },
      ],
      'find it',
    ),
    { name: 'search', arguments: { text: 'find it' } },
  );
  assert.equal(
    buildMcpToolCallParams(
      [{ name: 'query', inputSchema: { properties: { query: {} }, required: ['query', 'api_key'] } }],
      'find it',
    ),
    null,
  );
});

test('generic MCP request returns typed no-compatible-tool before tools/call dispatch', async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'babel-mcp-no-compatible-'));
  const serverPath = join(fixtureDir, 'server.cjs');
  const dispatchMarker = join(fixtureDir, 'tools-call-dispatched');
  const fixture = [
    "let input = ''; let initialized = false; let listed = false;",
    "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
    "function send(value) { process.stdout.write(frame(value)); }",
    "process.stdin.on('data', (chunk) => {",
    "  input += chunk.toString();",
    "  if (input.includes('\\\"method\\\":\\\"tools/call\\\"')) require('node:fs').writeFileSync(process.argv[2], 'dispatched');",
    "  if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; send({ jsonrpc: '2.0', id: 0, result: {} }); }",
    "  if (!listed && input.includes('\\\"id\\\":1')) { listed = true; send({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'query', inputSchema: { properties: { query: {} }, required: ['query', 'api_key'] } }] } }); }",
    "});",
  ].join('\n');
  try {
    writeFileSync(serverPath, fixture, 'utf8');
    const response = await handleMcpRequest(
      { tool: 'mcp_request', server: 'fixture', query: 'find it' },
      { fixture: { command: 'node', args: [serverPath, dispatchMarker] } },
    );
    assert.equal(response.exit_code, 1);
    assert.equal(response.failure?.code, 'no_compatible_mcp_tool');
    assert.equal(response.mcp_lifecycle?.reason_code, 'no_compatible_tool');
    assert.equal(existsSync(dispatchMarker), false);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('MCP state machine rejects out-of-order and duplicate initialize responses before duplicate dispatch', async () => {
  for (const duplicate of [false, true]) {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'babel-mcp-protocol-order-'));
    const serverPath = join(fixtureDir, 'server.cjs');
    const dispatchMarker = join(fixtureDir, 'tools-call-dispatched');
    const firstResponse = duplicate
      ? "send({ jsonrpc: '2.0', id: 0, result: {} }); send({ jsonrpc: '2.0', id: 0, result: {} });"
      : "send({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'MCP_OUT_OF_ORDER_SENTINEL' }] } });";
    const fixture = [
      "let input = ''; let replied = false;",
      "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
      "function send(value) { process.stdout.write(frame(value)); }",
      "process.stdin.on('data', (chunk) => {",
      "  input += chunk.toString();",
      "  if (input.includes('\\\"method\\\":\\\"tools/call\\\"')) require('node:fs').writeFileSync(process.argv[2], 'dispatched');",
      `  if (!replied && input.includes('\\"id\\":0')) { replied = true; ${firstResponse} }`,
      "});",
    ].join('\n');
    try {
      writeFileSync(serverPath, fixture, 'utf8');
      const response = await executeMcpMethod(
        'fixture',
        'tools/call',
        { name: 'lookup', arguments: { query: 'find it' } },
        undefined,
        { fixture: { command: 'node', args: [serverPath, dispatchMarker] } },
      );
      assert.equal(response.exit_code, 1, String(duplicate));
      assert.equal(response.failure?.code, 'mcp_protocol_error', String(duplicate));
      assert.equal(response.mcp_lifecycle?.reason_code, 'response_protocol_error', String(duplicate));
      if (!duplicate) assert.doesNotMatch(response.stderr, /MCP_OUT_OF_ORDER_SENTINEL/);
      if (!duplicate) assert.equal(existsSync(dispatchMarker), false);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
});

test('handleMcpToolCall cannot convert a malformed transport result into success evidence', async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'babel-mcp-tool-call-malformed-'));
  const serverPath = join(fixtureDir, 'server.cjs');
  const fixture = [
    "let input = ''; let initialized = false; let replied = false;",
    "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
    "function send(value) { process.stdout.write(frame(value)); }",
    "process.stdin.on('data', (chunk) => {",
    "  input += chunk.toString();",
    "  if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; send({ jsonrpc: '2.0', id: 0, result: {} }); }",
    "  if (!replied && input.includes('\\\"id\\\":1')) { replied = true; send({ jsonrpc: '2.0', id: 1, result: { leaked: 'MCP_HANDLE_TOOL_CALL_SENTINEL' } }); }",
    "});",
  ].join('\n');
  try {
    writeFileSync(serverPath, fixture, 'utf8');
    const response = await handleMcpToolCall(
      'fixture',
      'lookup',
      { query: 'find it' },
      undefined,
      { fixture: { command: 'node', args: [serverPath] } },
    );
    assert.equal(response.exit_code, 1);
    assert.equal(response.stdout, '');
    assert.equal(response.render_intent, 'tool_failure');
    assert.equal(response.failure?.code, 'invalid_mcp_tool_result');
    assert.doesNotMatch(response.stderr, /MCP_HANDLE_TOOL_CALL_SENTINEL/);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('MCP transport rejects request-shaped response frames in direct and generic flows', async () => {
  const directDir = mkdtempSync(join(tmpdir(), 'babel-mcp-request-frame-direct-'));
  const directServer = join(directDir, 'server.cjs');
  const directSentinel = 'MCP_REQUEST_FRAME_DIRECT_SENTINEL';
  const directFixture = [
    "let input = ''; let initialized = false; let replied = false;",
    "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
    "function send(value) { process.stdout.write(frame(value)); }",
    "process.stdin.on('data', (chunk) => {",
    "  input += chunk.toString();",
    "  if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; send({ jsonrpc: '2.0', id: 0, result: {} }); }",
    "  if (!replied && input.includes('\\\"id\\\":1')) { replied = true; send({ jsonrpc: '2.0', id: 1, method: 'tools/call', result: { content: [{ type: 'text', text: 'MCP_REQUEST_FRAME_DIRECT_SENTINEL' }] } }); }",
    "});",
  ].join('\n');

  try {
    writeFileSync(directServer, directFixture, 'utf8');
    const direct = await executeMcpMethod(
      'fixture',
      'tools/call',
      { name: 'lookup', arguments: { query: 'find it' } },
      undefined,
      { fixture: { command: 'node', args: [directServer] } },
    );
    assert.equal(direct.exit_code, 1);
    assert.equal(direct.failure?.code, 'mcp_protocol_error');
    assert.equal(direct.mcp_lifecycle?.reason_code, 'response_protocol_error');
    assert.doesNotMatch(direct.stderr, new RegExp(directSentinel));
  } finally {
    rmSync(directDir, { recursive: true, force: true });
  }

  const genericDir = mkdtempSync(join(tmpdir(), 'babel-mcp-request-frame-generic-'));
  const genericServer = join(genericDir, 'server.cjs');
  const dispatchMarker = join(genericDir, 'tools-call-dispatched');
  const genericSentinel = 'MCP_REQUEST_FRAME_GENERIC_SENTINEL';
  const genericFixture = [
    "let input = ''; let initialized = false; let replied = false;",
    "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
    "function send(value) { process.stdout.write(frame(value)); }",
    "process.stdin.on('data', (chunk) => {",
    "  input += chunk.toString();",
    "  if (input.includes('\\\"method\\\":\\\"tools/call\\\"')) require('node:fs').writeFileSync(process.argv[2], 'dispatched');",
    "  if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; send({ jsonrpc: '2.0', id: 0, result: {} }); }",
    "  if (!replied && input.includes('\\\"id\\\":1')) { replied = true; send({ jsonrpc: '2.0', id: 1, method: 'tools/list', result: { tools: [{ name: 'lookup', description: 'MCP_REQUEST_FRAME_GENERIC_SENTINEL' }] } }); }",
    "});",
  ].join('\n');

  try {
    writeFileSync(genericServer, genericFixture, 'utf8');
    const generic = await handleMcpRequest(
      { tool: 'mcp_request', server: 'fixture', query: 'find it' },
      { fixture: { command: 'node', args: [genericServer, dispatchMarker] } },
    );
    assert.equal(generic.exit_code, 1);
    assert.equal(generic.failure?.code, 'mcp_protocol_error');
    assert.equal(generic.mcp_lifecycle?.reason_code, 'response_protocol_error');
    assert.equal(existsSync(dispatchMarker), false);
    assert.doesNotMatch(generic.stderr, new RegExp(genericSentinel));
  } finally {
    rmSync(genericDir, { recursive: true, force: true });
  }
});
test('generic MCP validates a complete response batch before writing a later protocol step', async () => {
  for (const stage of ['initialize', 'tools_list'] as const) {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'babel-mcp-batch-transition-'));
    const serverPath = join(fixtureDir, 'server.cjs');
    const dispatchMarker = join(fixtureDir, 'later-protocol-step');
    const replies = stage === 'initialize'
      ? "if (!replied && input.includes('\\\"id\\\":0')) { replied = true; sendBatch([{ jsonrpc: '2.0', id: 0, result: {} }, { jsonrpc: '2.0', id: 0, result: {} }]); }"
      : "if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; send({ jsonrpc: '2.0', id: 0, result: {} }); } if (!replied && input.includes('\\\"id\\\":1')) { replied = true; sendBatch([{ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'lookup' }] } }, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'lookup' }] } }]); }";
    const markerCondition = stage === 'initialize'
      ? "input.includes('\\\"id\\\":1')"
      : "input.includes('\\\"id\\\":2')";
    const fixture = [
      "let input = ''; let initialized = false; let replied = false;",
      "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
      "function send(value) { process.stdout.write(frame(value)); }",
      "function sendBatch(values) { process.stdout.write(values.map(frame).join('')); }",
      "process.stdin.on('data', (chunk) => {",
      "  input += chunk.toString();",
      `  if (${markerCondition}) require('node:fs').writeFileSync(process.argv[2], 'dispatched');`,
      `  ${replies}`,
      "});",
    ].join('\n');
    try {
      writeFileSync(serverPath, fixture, 'utf8');
      const response = await handleMcpRequest(
        { tool: 'mcp_request', server: 'fixture', query: 'find it' },
        { fixture: { command: 'node', args: [serverPath, dispatchMarker] } },
      );
      assert.equal(response.exit_code, 1, stage);
      assert.equal(response.failure?.code, 'mcp_protocol_error', stage);
      assert.equal(response.mcp_lifecycle?.reason_code, 'response_protocol_error', stage);
      assert.equal(existsSync(dispatchMarker), false, stage);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
});
test('MCP discovery-list schemas reject unrecognised fields without returning them', async () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown> | undefined, string]> = [
    ['tools/list', { tools: [{ name: 'lookup', leaked: 'MCP_TOOLS_LIST_SENTINEL' }] }, undefined, 'MCP_TOOLS_LIST_SENTINEL'],
    ['resources/list', { resources: [{ uri: 'file:///unsafe', leaked: 'MCP_RESOURCES_LIST_SENTINEL' }] }, undefined, 'MCP_RESOURCES_LIST_SENTINEL'],
    ['prompts/list', { prompts: [{ name: 'unsafe', leaked: 'MCP_PROMPTS_LIST_SENTINEL' }] }, undefined, 'MCP_PROMPTS_LIST_SENTINEL'],
  ];
  for (const [method, result, params, sentinel] of cases) {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'babel-mcp-discovery-contract-'));
    const serverPath = join(fixtureDir, 'server.cjs');
    const fixture = [
      "let input = ''; let initialized = false; let replied = false;",
      "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
      "function send(value) { process.stdout.write(frame(value)); }",
      "process.stdin.on('data', (chunk) => {",
      "  input += chunk.toString();",
      "  if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; send({ jsonrpc: '2.0', id: 0, result: {} }); }",
      `  if (!replied && input.includes('\\\"id\\\":1')) { replied = true; send({ jsonrpc: '2.0', id: 1, result: ${JSON.stringify(result)} }); }`,
      "});",
    ].join('\n');
    try {
      writeFileSync(serverPath, fixture, 'utf8');
      const response = await executeMcpMethod(
        'fixture',
        method,
        params,
        undefined,
        { fixture: { command: 'node', args: [serverPath] } },
      );
      assert.equal(response.exit_code, 1, method);
      assert.equal(response.failure?.code, 'invalid_mcp_tool_result', method);
      assert.doesNotMatch(response.stderr, new RegExp(sentinel), method);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
});