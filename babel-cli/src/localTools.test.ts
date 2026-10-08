import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  executeTool,
  getExecutorToolRegistrySnapshot,
  getExecutorToolSnapshot,
  TOOL_CALL_REQUEST_TOOL_NAMES,
  shouldJitApprove,
} from './localTools.js';
import { EXECUTOR_TOOL_NAMES } from './tools/toolContracts.js';
import { ConfirmDialog } from './ui/dialog.js';
import { handleMcpRequest } from './tools/mcpTransport.js';

process.env['BABEL_UNIT_TEST'] = 'true';

const context = {
  agentId: 'test-agent',
  runId: 'test-run',
  babelRoot: process.cwd(),
};

async function withToolPolicyEnv<T>(
  allowed: string | undefined,
  disallowed: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previousAllowed = process.env['BABEL_ALLOWED_TOOLS'];
  const previousDisallowed = process.env['BABEL_DISALLOWED_TOOLS'];

  if (allowed === undefined) {
    delete process.env['BABEL_ALLOWED_TOOLS'];
  } else {
    process.env['BABEL_ALLOWED_TOOLS'] = allowed;
  }

  if (disallowed === undefined) {
    delete process.env['BABEL_DISALLOWED_TOOLS'];
  } else {
    process.env['BABEL_DISALLOWED_TOOLS'] = disallowed;
  }

  try {
    return await fn();
  } finally {
    if (previousAllowed === undefined) {
      delete process.env['BABEL_ALLOWED_TOOLS'];
    } else {
      process.env['BABEL_ALLOWED_TOOLS'] = previousAllowed;
    }

    if (previousDisallowed === undefined) {
      delete process.env['BABEL_DISALLOWED_TOOLS'];
    } else {
      process.env['BABEL_DISALLOWED_TOOLS'] = previousDisallowed;
    }
  }
}

describe('executeTool policy enforcement', () => {
  it('keeps mutating tools in dry-run mode by default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-dry-run-default-'));
    const previous = {
      projectRoot: process.env['BABEL_PROJECT_ROOT'],
      babelRoot: process.env['BABEL_ROOT'],
      dryRun: process.env['BABEL_DRY_RUN'],
      dryRunSource: process.env['BABEL_DRY_RUN_SOURCE'],
      live: process.env['BABEL_LIVE'],
    };

    try {
      process.env['BABEL_PROJECT_ROOT'] = root;
      process.env['BABEL_ROOT'] = root;
      delete process.env['BABEL_DRY_RUN'];
      delete process.env['BABEL_DRY_RUN_SOURCE'];
      delete process.env['BABEL_LIVE'];

      const result = await executeTool(
        {
          tool: 'file_write',
          path: 'out.txt',
          content: 'live write should not happen\n',
        },
        context,
      );

      assert.equal(result.exit_code, 0);
      assert.match(result.stdout, /\[DRY RUN\]/);
      assert.equal(existsSync(join(root, 'out.txt')), false);
    } finally {
      if (previous.projectRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
      else process.env['BABEL_PROJECT_ROOT'] = previous.projectRoot;
      if (previous.babelRoot === undefined) delete process.env['BABEL_ROOT'];
      else process.env['BABEL_ROOT'] = previous.babelRoot;
      if (previous.dryRun === undefined) delete process.env['BABEL_DRY_RUN'];
      else process.env['BABEL_DRY_RUN'] = previous.dryRun;
      if (previous.dryRunSource === undefined) delete process.env['BABEL_DRY_RUN_SOURCE'];
      else process.env['BABEL_DRY_RUN_SOURCE'] = previous.dryRunSource;
      if (previous.live === undefined) delete process.env['BABEL_LIVE'];
      else process.env['BABEL_LIVE'] = previous.live;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies tools listed in BABEL_DISALLOWED_TOOLS', async () => {
    const result = await withToolPolicyEnv(undefined, 'file_read', () =>
      executeTool(
        {
          tool: 'file_read',
          path: 'README.md',
        },
        context,
      ),
    );

    assert.equal(result.exit_code, 1);
    assert.equal(result.denial?.category, 'executor_policy');
    assert.equal(result.denial?.reason_code, 'tool_disallowed');
  });

  it('denies tools absent from BABEL_ALLOWED_TOOLS when an allowlist is set', async () => {
    const result = await withToolPolicyEnv('file_read', undefined, () =>
      executeTool(
        {
          tool: 'file_write',
          path: 'out.txt',
          content: 'x',
        },
        context,
      ),
    );

    assert.equal(result.exit_code, 1);
    assert.equal(result.denial?.category, 'executor_policy');
    assert.equal(result.denial?.reason_code, 'tool_not_allowed');
  });

  it('lets explicit deny rules take precedence over allow rules', async () => {
    const result = await withToolPolicyEnv('file_read', 'file_read', () =>
      executeTool(
        {
          tool: 'file_read',
          path: 'README.md',
        },
        context,
      ),
    );

    assert.equal(result.exit_code, 1);
    assert.equal(result.denial?.reason_code, 'tool_disallowed');
  });

  it('P2.4: file_read resolves under BABEL_PROJECT_ROOT not process.cwd()', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-project-root-pin-'));
    const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'config.json'),
        JSON.stringify({ name: 'test-app', version: '1.0.0' }),
        'utf-8',
      );
      // Without pin: relative path would look under cwd (babel-cli) → ENOENT risk
      delete process.env['BABEL_PROJECT_ROOT'];
      const missing = await executeTool(
        { tool: 'file_read', path: 'src/config.json' },
        context,
      );
      // May fail or read wrong tree depending on cwd; after pin must succeed with content
      process.env['BABEL_PROJECT_ROOT'] = root;
      const hit = await executeTool(
        { tool: 'file_read', path: 'src/config.json' },
        context,
      );
      assert.equal(hit.exit_code, 0, `expected read under pin; stderr=${hit.stderr}`);
      assert.match(hit.stdout, /test-app/);
      // Document pre-fix behavior: unpinned cwd often misses the temp fixture
      if (missing.exit_code === 0) {
        assert.doesNotMatch(
          missing.stdout,
          /test-app/,
          'unpinned read should not see the temp fixture content',
        );
      }
    } finally {
      if (previousProjectRoot === undefined) {
        delete process.env['BABEL_PROJECT_ROOT'];
      } else {
        process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies file writes listed in BABEL_LOCKED_FILES', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-locked-file-'));
    const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
    const previousLockedFiles = process.env['BABEL_LOCKED_FILES'];
    try {
      process.env['BABEL_PROJECT_ROOT'] = root;
      process.env['BABEL_LOCKED_FILES'] = JSON.stringify(['test_outputs.py']);
      const result = await executeTool(
        {
          tool: 'file_write',
          path: 'test_outputs.py',
          content: 'def test_fake(): pass\n',
        },
        context,
      );

      assert.equal(result.exit_code, 1);
      assert.match(result.stderr, /FILE_LOCK/);
    } finally {
      if (previousProjectRoot === undefined) {
        delete process.env['BABEL_PROJECT_ROOT'];
      } else {
        process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
      }
      if (previousLockedFiles === undefined) {
        delete process.env['BABEL_LOCKED_FILES'];
      } else {
        process.env['BABEL_LOCKED_FILES'] = previousLockedFiles;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('read-only search tools', () => {
  it('executes grep and glob within the configured project root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-local-tools-search-'));
    const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
    try {
      process.env['BABEL_PROJECT_ROOT'] = root;
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'needle.ts'), 'export class NeedleClass {}\n', 'utf-8');

      const grepResult = await executeTool(
        {
          tool: 'grep',
          pattern: 'NeedleClass',
        },
        context,
      );
      assert.equal(grepResult.exit_code, 0);
      assert.match(grepResult.stdout, /needle\.ts:1:/);

      const globResult = await executeTool(
        {
          tool: 'glob',
          pattern: 'src/*.ts',
        },
        context,
      );
      assert.equal(globResult.exit_code, 0);
      assert.match(globResult.stdout, /needle\.ts/);

      const symbolResult = await executeTool(
        {
          tool: 'workspace_symbol_search',
          query: 'NeedleClass',
        },
        context,
      );
      assert.equal(symbolResult.exit_code, 0);
      assert.match(symbolResult.stdout, /needle\.ts:1:.*NeedleClass/);
    } finally {
      if (previousProjectRoot === undefined) {
        delete process.env['BABEL_PROJECT_ROOT'];
      } else {
        process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('executor tool registry snapshot', () => {
  it('exposes the registered executor tools without handlers', () => {
    const tools = getExecutorToolRegistrySnapshot();
    const names = tools.map((tool) => tool.name);

    assert.deepEqual(names, [...EXECUTOR_TOOL_NAMES]);
    assert.deepEqual([...TOOL_CALL_REQUEST_TOOL_NAMES], [...EXECUTOR_TOOL_NAMES]);

    assert.equal(
      tools.some((tool) => 'handler' in tool),
      false,
    );
  });

  it('supports inspecting one registered tool', () => {
    const tool = getExecutorToolSnapshot('shell_exec');

    assert.equal(tool?.name, 'shell_exec');
    assert.equal(tool?.category, 'process');
    assert.equal(tool?.mutating, true);
    assert.deepEqual(tool?.input.required, ['command']);
    assert.deepEqual(tool?.input.optional, ['working_directory', 'timeout_seconds']);
  });
});

describe('shouldJitApprove logic', () => {
  it('triggers JIT when BABEL_ASK is true', () => {
    const prevAsk = process.env['BABEL_ASK'];
    const prevLive = process.env['BABEL_LIVE'];
    try {
      process.env['BABEL_ASK'] = 'true';
      process.env['BABEL_LIVE'] = 'true';
      const fileWriteReq = { tool: 'file_write' as const, path: 'src/main.ts', content: 'x' };
      const grepReq = { tool: 'grep' as const, pattern: 'search' };
      assert.equal(shouldJitApprove(fileWriteReq), true);
      assert.equal(shouldJitApprove(grepReq), false);
    } finally {
      if (prevAsk === undefined) delete process.env['BABEL_ASK'];
      else process.env['BABEL_ASK'] = prevAsk;
      if (prevLive === undefined) delete process.env['BABEL_LIVE'];
      else process.env['BABEL_LIVE'] = prevLive;
    }
  });

  it('triggers JIT under default mode if touching control-plane files', () => {
    const prevAsk = process.env['BABEL_ASK'];
    const prevLive = process.env['BABEL_LIVE'];
    try {
      delete process.env['BABEL_ASK'];
      process.env['BABEL_LIVE'] = 'true';
      const normalWrite = { tool: 'file_write' as const, path: 'src/main.ts', content: 'x' };
      const controlWrite = {
        tool: 'file_write' as const,
        path: 'prompt_catalog.yaml',
        content: 'x',
      };
      assert.equal(shouldJitApprove(normalWrite), false);
      assert.equal(shouldJitApprove(controlWrite), true);
    } finally {
      if (prevAsk === undefined) delete process.env['BABEL_ASK'];
      else process.env['BABEL_ASK'] = prevAsk;
      if (prevLive === undefined) delete process.env['BABEL_LIVE'];
      else process.env['BABEL_LIVE'] = prevLive;
    }
  });

  it('triggers JIT under default mode if writing outside anchorPath', () => {
    const prevAsk = process.env['BABEL_ASK'];
    const prevLive = process.env['BABEL_LIVE'];
    const prevAnchor = process.env['BABEL_ANCHOR_PATH'];
    const prevProjRoot = process.env['BABEL_PROJECT_ROOT'];
    try {
      delete process.env['BABEL_ASK'];
      process.env['BABEL_LIVE'] = 'true';
      process.env['BABEL_PROJECT_ROOT'] = process.cwd();
      process.env['BABEL_ANCHOR_PATH'] = 'babel-cli';

      const insideWrite = {
        tool: 'file_write' as const,
        path: 'babel-cli/src/main.ts',
        content: 'x',
      };
      const outsideWrite = {
        tool: 'file_write' as const,
        path: 'docs/MAINTENANCE.md',
        content: 'x',
      };

      assert.equal(shouldJitApprove(insideWrite), false);
      assert.equal(shouldJitApprove(outsideWrite), true);
    } finally {
      if (prevAsk === undefined) delete process.env['BABEL_ASK'];
      else process.env['BABEL_ASK'] = prevAsk;
      if (prevLive === undefined) delete process.env['BABEL_LIVE'];
      else process.env['BABEL_LIVE'] = prevLive;
      if (prevAnchor === undefined) delete process.env['BABEL_ANCHOR_PATH'];
      else process.env['BABEL_ANCHOR_PATH'] = prevAnchor;
      if (prevProjRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
      else process.env['BABEL_PROJECT_ROOT'] = prevProjRoot;
    }
  });

  it('triggers JIT if recovery loop is active', () => {
    const prevAsk = process.env['BABEL_ASK'];
    const prevLive = process.env['BABEL_LIVE'];
    const prevRecovery = process.env['BABEL_RECOVERY_LOOP'];
    try {
      delete process.env['BABEL_ASK'];
      process.env['BABEL_LIVE'] = 'true';
      process.env['BABEL_RECOVERY_LOOP'] = 'true';

      const normalWrite = { tool: 'file_write' as const, path: 'src/main.ts', content: 'x' };
      assert.equal(shouldJitApprove(normalWrite), true);
    } finally {
      if (prevAsk === undefined) delete process.env['BABEL_ASK'];
      else process.env['BABEL_ASK'] = prevAsk;
      if (prevLive === undefined) delete process.env['BABEL_LIVE'];
      else process.env['BABEL_LIVE'] = prevLive;
      if (prevRecovery === undefined) delete process.env['BABEL_RECOVERY_LOOP'];
      else process.env['BABEL_RECOVERY_LOOP'] = prevRecovery;
    }
  });
});


describe('MCP operator approval handoff', () => {
  it('executes only an explicitly approved JIT request and keeps unapproved direct requests denied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-mcp-jit-'));
    const keys = ['BABEL_CONFIG_DIR', 'BABEL_PROJECT_ROOT', 'BABEL_ROOT', 'BABEL_ASK', 'BABEL_LIVE', 'BABEL_DRY_RUN', 'BABEL_DAEMON', 'BABEL_MCP_APPROVAL_EXPIRES', 'CI', 'BABEL_NON_INTERACTIVE'] as const;
    const saved = new Map(keys.map(key => [key, process.env[key]]));
    const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    let prompts = 0;
    let changedDuringApproval: Extract<import('./localTools.js').ToolCallRequest, { tool: 'mcp_request' }> | undefined;
    const dialog = mock.method(ConfirmDialog, 'show', async () => {
      prompts++;
      if (prompts === 3 && changedDuringApproval) changedDuringApproval.query = 'substituted query';
      return prompts !== 2;
    });
    const server = join(root, 'server.cjs');
    writeFileSync(server, `
let input = Buffer.alloc(0);
function send(id, result) { const body = JSON.stringify({ jsonrpc: '2.0', id, result }); process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body); }
process.stdin.on('data', chunk => {
 input = Buffer.concat([input, chunk]);
 while (true) {
  const end = input.indexOf('\\r\\n\\r\\n'); if (end < 0) return;
  const size = Number(/Content-Length: (\\d+)/i.exec(input.subarray(0, end).toString())[1]);
  if (input.length < end + 4 + size) return;
  const message = JSON.parse(input.subarray(end + 4, end + 4 + size).toString()); input = input.subarray(end + 4 + size);
  if (message.method === 'initialize') send(message.id, {});
  if (message.method === 'tools/list') send(message.id, { tools: [{ name: 'lookup', inputSchema: { properties: { query: {} } }, annotations: { readOnlyHint: true, destructiveHint: false } }] });
  if (message.method === 'tools/call') send(message.id, { content: [{ type: 'text', text: 'approved fixture result' }] });
 }
});
`);
    writeFileSync(join(root, 'mcp_servers.json'), JSON.stringify({ servers: { fixture: { command: 'node', args: [server] } } }));
    try {
      for (const key of keys) delete process.env[key];
      process.env['BABEL_CONFIG_DIR'] = root;
      process.env['BABEL_PROJECT_ROOT'] = root;
      process.env['BABEL_ROOT'] = root;
      process.env['BABEL_ASK'] = 'true';
      process.env['BABEL_LIVE'] = 'true';
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      const result = await executeTool({ tool: 'mcp_request', server: 'fixture', query: 'approved query' }, { ...context, runId: 'mcp-jit', projectRoot: root, babelRoot: root });
      assert.equal(prompts, 1);
      assert.equal(result.exit_code, 0, result.stderr);
      assert.match(result.stdout, /approved fixture result/);
      assert.equal(process.env['BABEL_MCP_APPROVAL_EXPIRES'], undefined, 'JIT never grants process-wide approval');
      const direct = await handleMcpRequest({ tool: 'mcp_request', server: 'fixture', query: 'approved query' });
      assert.equal(direct.failure?.code, 'mcp_approval_required');
      const denied = await executeTool({ tool: 'mcp_request', server: 'fixture', query: 'denied query' }, { ...context, runId: 'mcp-jit-denied', projectRoot: root, babelRoot: root });
      assert.equal(prompts, 2);
      assert.match(denied.stderr, /JIT_DENIED/);
      delete process.env['BABEL_ASK'];
      const seeded = await executeTool({ tool: 'mcp_request', server: 'fixture', query: 'substituted query' }, { ...context, runId: 'mcp-jit-cache', projectRoot: root, babelRoot: root });
      assert.equal(seeded.exit_code, 0, seeded.stderr);
      process.env['BABEL_ASK'] = 'true';
      changedDuringApproval = { tool: 'mcp_request', server: 'fixture', query: 'presented query' };
      const changed = await executeTool(changedDuringApproval, { ...context, runId: 'mcp-jit-changed', projectRoot: root, babelRoot: root });
      assert.equal(prompts, 3);
      assert.equal(changed.failure?.code, 'mcp_approval_required', 'request fields changed during approval cannot inherit the grant');
    } finally {
      dialog.mock.restore();
      if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      for (const key of keys) { const value = saved.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
