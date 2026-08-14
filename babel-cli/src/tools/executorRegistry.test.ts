import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ToolCallRequest, ToolContext } from '../localTools.js';
import { createExecutorToolRegistry, type ExecutorToolDefinition } from './executorRegistry.js';
import { handleMcpRequest, handleMcpToolSearch } from './mcpTransport.js';

const context: ToolContext = {
  agentId: 'test-agent',
  runId: 'test-run',
  babelRoot: process.cwd(),
};

function makeDefinition(name: ToolCallRequest['tool']): ExecutorToolDefinition {
  return {
    name,
    category: 'filesystem',
    description: 'Test tool',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['test'],
    input: {
      required: [],
      optional: [],
    },
    handler: () => ({
      exit_code: 0,
      stdout: name,
      stderr: '',
    }),
  };
}

describe('executor tool registry', () => {
  it('rejects duplicate registrations', () => {
    const definition = makeDefinition('file_read');

    assert.throws(
      () => createExecutorToolRegistry([definition, definition]),
      /Duplicate executor tool registration: file_read/,
    );
  });

  it('dispatches through registered handlers and exposes handler-free snapshots', async () => {
    const registry = createExecutorToolRegistry([makeDefinition('file_read')]);
    const result = await registry.dispatch(
      {
        tool: 'file_read',
        path: 'README.md',
      },
      context,
    );

    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, 'file_read');

    const snapshots = registry.list();
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.name, 'file_read');
    assert.equal('handler' in (snapshots[0] ?? {}), false);
  });
  it('turns malformed shell output into a typed failure instead of success evidence', async () => {
    const definition = makeDefinition('shell_exec');
    definition.handler = () => ({ exit_code: 0, stdout: 42, stderr: '' }) as unknown as never;
    const result = await createExecutorToolRegistry([definition]).dispatch(
      { tool: 'shell_exec', command: 'node --version' },
      context,
    );

    assert.equal(result.exit_code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.failure?.code, 'invalid_tool_result');
    assert.equal(result.render_intent, 'tool_failure');
  });

  it('requires an explicit receipt for successful mutation output', async () => {
    const definition = makeDefinition('file_write');
    definition.mutating = true;
    definition.handler = () => ({ exit_code: 0, stdout: '', stderr: '' });
    const result = await createExecutorToolRegistry([definition]).dispatch(
      { tool: 'file_write', path: 'out.txt', content: 'x' },
      context,
    );

    assert.equal(result.exit_code, 1);
    assert.equal(result.failure?.code, 'invalid_tool_result');
    assert.equal(result.render_intent, 'tool_failure');
  });

  it('keeps successful silent git reset output compatible', async () => {
    const definition = makeDefinition('git_reset');
    definition.mutating = true;
    definition.handler = () => ({ exit_code: 0, stdout: '', stderr: '' });
    const result = await createExecutorToolRegistry([definition]).dispatch(
      { tool: 'git_reset', hard: false },
      context,
    );

    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.render_intent, undefined);
  });
  it('adds explicit render intent to normal shell and mutation results', async () => {
    const shell = await createExecutorToolRegistry([makeDefinition('shell_exec')]).dispatch(
      { tool: 'shell_exec', command: 'node --version' },
      context,
    );
    const writeDefinition = makeDefinition('file_write');
    writeDefinition.mutating = true;
    const write = await createExecutorToolRegistry([writeDefinition]).dispatch(
      { tool: 'file_write', path: 'out.txt', content: 'x' },
      context,
    );

    assert.equal(shell.exit_code, 0);
    assert.equal(shell.render_intent, 'shell_output');
    assert.equal(write.exit_code, 0);
    assert.equal(write.render_intent, 'mutation_receipt');
  });
  it('rejects arbitrary substituted MCP success stdout without a completed semantic lifecycle', async () => {
    const sentinel = 'SUBSTITUTED_MCP_STDOUT_SENTINEL';
    const definition = makeDefinition('mcp_request');
    definition.handler = () => ({ exit_code: 0, stdout: sentinel, stderr: '' });
    const result = await createExecutorToolRegistry([definition]).dispatch(
      { tool: 'mcp_request', server: 'fixture', query: 'find it' },
      context,
    );

    assert.equal(result.exit_code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.render_intent, 'tool_failure');
    assert.equal(result.failure?.code, 'invalid_mcp_tool_result');
    assert.doesNotMatch(result.stderr, new RegExp(sentinel));
  });

  it('accepts MCP success only with the recognised completed transport contract', async () => {
    const definition = makeDefinition('mcp_request');
    definition.handler = () => ({
      exit_code: 0,
      stdout: JSON.stringify({ status: 'success', server: 'fixture', method: 'tools/list', result: { tools: [] } }),
      stderr: '',
      mcp_lifecycle: {
        phase: 'complete',
        outcome: 'success',
        reason_code: 'response_received',
        server: 'fixture',
        evidence: null,
      },
    });
    const result = await createExecutorToolRegistry([definition]).dispatch(
      { tool: 'mcp_request', server: 'fixture', query: 'find it' },
      context,
    );

    assert.equal(result.exit_code, 0);
    assert.equal(result.render_intent, 'mcp_result');
  });
  it('accepts a strict canonical mcp_tool_search result through the registry', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'babel-mcp-registry-search-'));
    const serverPath = join(fixtureDir, 'server.cjs');
    const fixture = [
      "let input = ''; let initialized = false; let listed = false;",
      "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
      "function send(value) { process.stdout.write(frame(value)); }",
      "process.stdin.on('data', (chunk) => {",
      "  input += chunk.toString();",
      "  if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; send({ jsonrpc: '2.0', id: 0, result: {} }); }",
      "  if (!listed && input.includes('\\\"id\\\":1')) { listed = true; send({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'lookup', description: 'Find safe facts', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] } }); }",
      "});",
    ].join('\n');
    const definition = makeDefinition('mcp_tool_search');
    definition.handler = (req) => handleMcpToolSearch(
      req as Extract<ToolCallRequest, { tool: 'mcp_tool_search' }>,
      { fixture: { command: 'node', args: [serverPath] } },
    );

    try {
      writeFileSync(serverPath, fixture, 'utf8');
      const result = await createExecutorToolRegistry([definition]).dispatch(
        { tool: 'mcp_tool_search', server: 'fixture', query: 'lookup' },
        context,
      );

      assert.equal(result.exit_code, 0);
      assert.equal(result.render_intent, 'mcp_result');
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(payload['method'], 'tools/search');
      assert.equal(payload['query'], 'lookup');
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
  it('rejects a substituted completed MCP lifecycle with a noncanonical nested result', async () => {
    const sentinel = 'FORGED_MCP_NESTED_SENTINEL';
    const definition = makeDefinition('mcp_request');
    definition.handler = () => ({
      exit_code: 0,
      stdout: JSON.stringify({
        status: 'success',
        server: 'fixture',
        method: 'tools/call',
        result: { content: [{ type: 'text', text: 'safe result', leaked: sentinel }] },
      }),
      stderr: '',
      mcp_lifecycle: {
        phase: 'complete',
        outcome: 'success',
        reason_code: 'response_received',
        server: 'fixture',
        evidence: null,
      },
    });

    const result = await createExecutorToolRegistry([definition]).dispatch(
      { tool: 'mcp_request', server: 'fixture', query: 'find it' },
      context,
    );

    assert.equal(result.exit_code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.failure?.code, 'invalid_mcp_tool_result');
    assert.doesNotMatch(result.stderr, new RegExp(sentinel));
  });
  it('rejects a generic MCP response with a valid text block plus an unrecognised sentinel field', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'babel-mcp-registry-sentinel-'));
    const serverPath = join(fixtureDir, 'server.cjs');
    const sentinel = 'MCP_REGISTRY_NESTED_SENTINEL';
    const fixture = [
      "let input = ''; let initialized = false; let listed = false; let called = false;",
      "function frame(value) { const body = JSON.stringify(value); return 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body; }",
      "function send(value) { process.stdout.write(frame(value)); }",
      "process.stdin.on('data', (chunk) => {",
      "  input += chunk.toString();",
      "  if (!initialized && input.includes('\\\"id\\\":0')) { initialized = true; send({ jsonrpc: '2.0', id: 0, result: {} }); }",
      "  if (!listed && input.includes('\\\"id\\\":1')) { listed = true; send({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] } }); }",
      "  if (!called && input.includes('\\\"id\\\":2')) { called = true; send({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'safe result', leaked: 'MCP_REGISTRY_NESTED_SENTINEL' }] } }); }",
      "});",
    ].join('\n');
    const definition = makeDefinition('mcp_request');
    definition.handler = (req) => handleMcpRequest(
      req as Extract<ToolCallRequest, { tool: 'mcp_request' }>,
      { fixture: { command: 'node', args: [serverPath] } },
    );

    try {
      writeFileSync(serverPath, fixture, 'utf8');
      const result = await createExecutorToolRegistry([definition]).dispatch(
        { tool: 'mcp_request', server: 'fixture', query: 'find it' },
        context,
      );

      assert.equal(result.exit_code, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.failure?.code, 'invalid_mcp_tool_result');
      assert.doesNotMatch(result.stderr, new RegExp(sentinel));
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
