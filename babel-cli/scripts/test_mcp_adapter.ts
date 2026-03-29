import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { previewInstructionStackResolution } from '../src/control-plane/stackResolver.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: Record<string, unknown>;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
  };
}

type JsonRpcMessage = JsonRpcSuccess | JsonRpcError;

interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

class McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stderrChunks: string[] = [];
  private readonly messages: JsonRpcMessage[] = [];
  private readonly waiters: Array<(message: JsonRpcMessage) => void> = [];
  private buffer = Buffer.alloc(0);
  private nextId = 1;

  constructor(
    child: ChildProcessWithoutNullStreams,
  ) {
    this.child = child;
    this.child.stdout.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drainMessages();
    });
    this.child.stderr.on('data', chunk => {
      this.stderrChunks.push(chunk.toString('utf8'));
    });
  }

  private drainMessages(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const headerText = this.buffer.subarray(0, headerEnd).toString('utf8');
      const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!contentLengthMatch) {
        throw new Error(`Missing Content-Length header. stderr=${this.stderr()}`);
      }

      const contentLength = Number.parseInt(contentLengthMatch[1]!, 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) {
        return;
      }

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8');
      this.buffer = this.buffer.subarray(bodyEnd);
      const message = JSON.parse(body) as JsonRpcMessage;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        this.messages.push(message);
      }
    }
  }

  stderr(): string {
    return this.stderrChunks.join('');
  }

  private async nextMessage(timeoutMs = 10_000): Promise<JsonRpcMessage> {
    const queued = this.messages.shift();
    if (queued) {
      return queued;
    }

    return await new Promise<JsonRpcMessage>((resolveMessage, rejectMessage) => {
      const timeout = setTimeout(() => {
        rejectMessage(new Error(`Timed out waiting for MCP response. stderr=${this.stderr()}`));
      }, timeoutMs);

      this.waiters.push(message => {
        clearTimeout(timeout);
        resolveMessage(message);
      });
    });
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params ? { params } : {}),
    });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    const message = await this.nextMessage();
    assert(message.id === id, `Expected MCP response id ${id}, got ${String(message.id)}`);
    return message;
  }

  notify(method: string): void {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
    });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  }
}

function makeInstructionStack() {
  return {
    behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
    domain_id: 'domain_swe_backend',
    skill_ids: [],
    model_adapter_id: 'adapter_codex_balanced',
    project_overlay_id: null,
    task_overlay_ids: [],
    pipeline_stage_ids: ['pipeline_qa_reviewer'],
  };
}

function makeResolutionPolicy() {
  return {
    apply_domain_default_skills: true,
    expand_skill_dependencies: true,
    strict_conflict_mode: 'error' as const,
  };
}

async function withServer(
  run: (client: McpClient, runArtifactsRoot: string, repoRoot: string) => Promise<void>,
): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const cliRoot = resolve(scriptDir, '..');
  const repoRoot = resolve(cliRoot, '..');
  const runArtifactsRoot = mkdtempSync(join(tmpdir(), 'babel-mcp-runs-'));
  const tsxBinary = join(
    cliRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );

  mkdirSync(runArtifactsRoot, { recursive: true });

  const child = spawn(
    tsxBinary,
    ['src/index.ts', 'mcp'],
    {
      cwd: cliRoot,
      env: {
        ...process.env,
        BABEL_ROOT: repoRoot,
        BABEL_RUNS_DIR: runArtifactsRoot,
      },
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  const client = new McpClient(child);

  try {
    const initializeResponse = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'babel-tests', version: '1.0.0' },
    });
    assert('result' in initializeResponse, `Expected initialize success. stderr=${client.stderr()}`);
    client.notify('notifications/initialized');
    await run(client, runArtifactsRoot, repoRoot);
  } finally {
    child.kill();
    rmSync(runArtifactsRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await withServer(async (client, runArtifactsRoot, repoRoot) => {
    const beforeRunArtifacts = readdirSync(runArtifactsRoot);

    const toolListResponse = await client.request('tools/list');
    assert('result' in toolListResponse, 'tools/list should succeed');
    const tools = (toolListResponse.result['tools'] as Array<{ name?: string }> | undefined) ?? [];
    const toolNames = tools.map(tool => tool.name).filter((name): name is string => typeof name === 'string').sort();
    assert(
      JSON.stringify(toolNames) === JSON.stringify([
        'babel_catalog_inspect',
        'babel_instruction_stack_preview',
        'babel_manifest_preview',
        'babel_stack_resolve',
      ]),
      `Expected four read-only Phase 1 tools, got ${JSON.stringify(toolNames)}`,
    );

    const instructionStack = makeInstructionStack();
    const resolutionPolicy = makeResolutionPolicy();
    const expectedPreview = previewInstructionStackResolution(
      instructionStack,
      resolutionPolicy,
      repoRoot,
      join(repoRoot, 'prompt_catalog.yaml'),
    );

    const previewResponse = await client.request('tools/call', {
      name: 'babel_instruction_stack_preview',
      arguments: {
        instruction_stack: instructionStack,
        resolution_policy: resolutionPolicy,
      },
    });
    assert('result' in previewResponse, 'babel_instruction_stack_preview should succeed');
    const previewResult = previewResponse.result as McpToolResult;
    assert(previewResult.isError === false, 'babel_instruction_stack_preview should not report an error');
    assert(
      JSON.stringify(previewResult.structuredContent?.['ordered_entries'] ?? null) === JSON.stringify(expectedPreview.orderedEntries),
      'ordered_entries should match the resolver preview exactly',
    );
    assert(
      JSON.stringify(previewResult.structuredContent?.['budget_summary'] ?? null) === JSON.stringify({
        token_budget_total: expectedPreview.compiledArtifacts.token_budget_total,
        token_budget_missing: expectedPreview.compiledArtifacts.token_budget_missing,
        budget_policy: expectedPreview.compiledArtifacts.budget_policy,
        budget_diagnostics: expectedPreview.compiledArtifacts.budget_diagnostics,
      }),
      'budget_summary should match the resolver preview exactly',
    );

    const manifestResponse = await client.request('tools/call', {
      name: 'babel_manifest_preview',
      arguments: {
        instruction_stack: instructionStack,
        resolution_policy: resolutionPolicy,
      },
    });
    assert('result' in manifestResponse, 'babel_manifest_preview should succeed');
    const manifestResult = manifestResponse.result as McpToolResult;
    assert(manifestResult.isError === false, 'babel_manifest_preview should not report an error');
    assert(
      JSON.stringify(manifestResult.structuredContent?.['compiled_artifacts'] ?? null) === JSON.stringify(expectedPreview.compiledArtifacts),
      'compiled_artifacts should match the resolver preview exactly',
    );
    assert(
      JSON.stringify(manifestResult.structuredContent?.['prompt_manifest'] ?? null) === JSON.stringify(expectedPreview.compiledArtifacts.prompt_manifest),
      'prompt_manifest should mirror compiled_artifacts.prompt_manifest',
    );

    const resolveResponse = await client.request('tools/call', {
      name: 'babel_stack_resolve',
      arguments: {
        instruction_stack: instructionStack,
        resolution_policy: resolutionPolicy,
      },
    });
    assert('result' in resolveResponse, 'babel_stack_resolve should succeed');
    const resolveResult = resolveResponse.result as McpToolResult;
    assert(resolveResult.isError === false, 'babel_stack_resolve should not report an error');
    assert(
      JSON.stringify(resolveResult.structuredContent?.['compiled_artifacts'] ?? null) === JSON.stringify(expectedPreview.compiledArtifacts),
      'babel_stack_resolve compiled_artifacts should match the resolver preview exactly',
    );

    const catalogResponse = await client.request('tools/call', {
      name: 'babel_catalog_inspect',
      arguments: {
        ids: ['meta_mcp_adapter_v1'],
      },
    });
    assert('result' in catalogResponse, 'babel_catalog_inspect should succeed');
    const catalogResult = catalogResponse.result as McpToolResult;
    assert(catalogResult.isError === false, 'babel_catalog_inspect should not report an error');
    const catalogEntries = (catalogResult.structuredContent?.['entries'] as Array<{ id?: string }> | undefined) ?? [];
    assert(catalogEntries.length === 1 && catalogEntries[0]?.id === 'meta_mcp_adapter_v1', 'catalog inspection should find the MCP adapter doc entry');

    const mutatingResponse = await client.request('tools/call', {
      name: 'file_write',
      arguments: {},
    });
    assert('result' in mutatingResponse, 'mutating tool calls should fail closed with a result payload');
    const mutatingResult = mutatingResponse.result as McpToolResult;
    assert(mutatingResult.isError === true, 'mutating tool calls should be rejected');

    const unknownResponse = await client.request('tools/call', {
      name: 'babel_not_real',
      arguments: {},
    });
    assert('error' in unknownResponse, 'unknown tools should return a JSON-RPC error');
    assert(unknownResponse.error.code === -32601, `Expected -32601 for unknown tools, got ${unknownResponse.error.code}`);

    const afterRunArtifacts = readdirSync(runArtifactsRoot);
    assert(
      JSON.stringify(afterRunArtifacts) === JSON.stringify(beforeRunArtifacts),
      `MCP preview calls should not create run artifacts. before=${JSON.stringify(beforeRunArtifacts)} after=${JSON.stringify(afterRunArtifacts)}`,
    );
  });

  console.log('mcp adapter regression tests passed');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
