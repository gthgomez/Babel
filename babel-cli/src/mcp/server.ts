import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { z } from 'zod';

import { inspectCatalog } from '../control-plane/stackResolver.js';
import { previewInstructionStackResolution } from '../control-plane/stackResolver.js';
import type { CatalogEntry } from '../control-plane/catalog.js';
import type {
  InstructionStack,
  ResolutionPolicy,
} from '../schemas/agentContracts.js';
import {
  InstructionStackSchema,
  ResolutionPolicySchema,
} from '../schemas/agentContracts.js';

const BABEL_ROOT = process.env['BABEL_ROOT'] ?? resolve(import.meta.dirname, '..', '..', '..');
const CATALOG_PATH = resolve(BABEL_ROOT, 'prompt_catalog.yaml');
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'babel-mcp';
const SERVER_VERSION = '1.0.0';

const CatalogInspectArgsSchema = z.object({
  ids: z.array(z.string().min(1)).optional(),
  layer: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  project: z.string().min(1).optional(),
});

const StackArgsSchema = z.object({
  instruction_stack: InstructionStackSchema,
  resolution_policy: ResolutionPolicySchema,
});

type ToolHandler = (args: unknown) => Promise<unknown>;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

function asCatalogOutput(entry: CatalogEntry): Record<string, unknown> {
  return {
    id: entry.id,
    layer: entry.layer,
    path: entry.path,
    load_position: entry.loadPosition,
    status: entry.status,
    dependencies: [...entry.dependencies],
    conflicts: [...entry.conflicts],
    default_skill_ids: [...entry.defaultSkillIds],
    token_budget: entry.tokenBudget,
    tags: [...entry.tags],
    project: entry.project,
  };
}

function buildIntegrityWarnings(entries: CatalogEntry[]): string[] {
  const warnings: string[] = [];
  for (const entry of entries) {
    if (entry.tokenBudget === null) {
      warnings.push(`Missing token_budget for ID '${entry.id}'`);
    }
    if (!entry.path) {
      warnings.push(`Missing path for ID '${entry.id}'`);
    }
  }
  return warnings;
}

async function handleCatalogInspect(args: unknown): Promise<unknown> {
  const parsed = CatalogInspectArgsSchema.parse(args ?? {});
  const filters = {
    ...(parsed.ids ? { ids: parsed.ids } : {}),
    ...(parsed.layer ? { layer: parsed.layer } : {}),
    ...(parsed.status ? { status: parsed.status } : {}),
    ...(parsed.tags ? { tags: parsed.tags } : {}),
    ...(parsed.project ? { project: parsed.project } : {}),
  };
  const entries = inspectCatalog(CATALOG_PATH, filters);

  return {
    entries: entries.map(asCatalogOutput),
    integrity_warnings: buildIntegrityWarnings(entries),
  };
}

async function handleStackResolve(args: unknown): Promise<unknown> {
  const parsed = StackArgsSchema.parse(args ?? {});
  const preview = previewInstructionStackResolution(
    parsed.instruction_stack,
    parsed.resolution_policy,
    BABEL_ROOT,
    CATALOG_PATH,
  );

  return {
    compiled_artifacts: preview.compiledArtifacts,
    prompt_manifest: [...preview.compiledArtifacts.prompt_manifest],
  };
}

async function handleInstructionStackPreview(args: unknown): Promise<unknown> {
  const parsed = StackArgsSchema.parse(args ?? {});
  const preview = previewInstructionStackResolution(
    parsed.instruction_stack,
    parsed.resolution_policy,
    BABEL_ROOT,
    CATALOG_PATH,
  );

  return {
    ordered_entries: preview.orderedEntries,
    budget_summary: {
      token_budget_total: preview.compiledArtifacts.token_budget_total,
      token_budget_missing: [...preview.compiledArtifacts.token_budget_missing],
      budget_policy: preview.compiledArtifacts.budget_policy,
      budget_diagnostics: [...preview.compiledArtifacts.budget_diagnostics],
    },
  };
}

async function handleManifestPreview(args: unknown): Promise<unknown> {
  const parsed = StackArgsSchema.parse(args ?? {});
  const preview = previewInstructionStackResolution(
    parsed.instruction_stack,
    parsed.resolution_policy,
    BABEL_ROOT,
    CATALOG_PATH,
  );

  return {
    compilation_state: 'compiled',
    prompt_manifest: [...preview.compiledArtifacts.prompt_manifest],
    compiled_artifacts: preview.compiledArtifacts,
  };
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'babel_catalog_inspect',
    description: 'Inspect the Babel prompt catalog with optional filters. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        layer: { type: 'string' },
        status: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        project: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: handleCatalogInspect,
  },
  {
    name: 'babel_stack_resolve',
    description: 'Resolve a typed instruction stack into compiled_artifacts and prompt_manifest. Read-only.',
    inputSchema: {
      type: 'object',
      required: ['instruction_stack', 'resolution_policy'],
      properties: {
        instruction_stack: { type: 'object' },
        resolution_policy: { type: 'object' },
      },
      additionalProperties: false,
    },
    handler: handleStackResolve,
  },
  {
    name: 'babel_instruction_stack_preview',
    description: 'Preview the ordered entries and budget summary for a typed instruction stack. Read-only.',
    inputSchema: {
      type: 'object',
      required: ['instruction_stack', 'resolution_policy'],
      properties: {
        instruction_stack: { type: 'object' },
        resolution_policy: { type: 'object' },
      },
      additionalProperties: false,
    },
    handler: handleInstructionStackPreview,
  },
  {
    name: 'babel_manifest_preview',
    description: 'Preview the compiled manifest shape Babel would use for a typed instruction stack. Read-only.',
    inputSchema: {
      type: 'object',
      required: ['instruction_stack', 'resolution_policy'],
      properties: {
        instruction_stack: { type: 'object' },
        resolution_policy: { type: 'object' },
      },
      additionalProperties: false,
    },
    handler: handleManifestPreview,
  },
];

const TOOL_NAMES = new Set(TOOLS.map(tool => tool.name));
const EXPLICITLY_DISALLOWED_TOOLS = new Set([
  'runBabelPipeline',
  'file_write',
  'shell_exec',
  'test_run',
  'audit_ui',
  'memory_store',
  'mcp_request',
]);

function writeMessage(message: Record<string, unknown>): void {
  const body = JSON.stringify(message);
  const payload = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
  process.stdout.write(payload);
}

function writeResult(id: string | number, result: Record<string, unknown>): void {
  writeMessage({
    jsonrpc: '2.0',
    id,
    result,
  });
}

function writeError(id: string | number | null, code: number, message: string): void {
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  });
}

async function handleRequest(request: Record<string, unknown>): Promise<void> {
  const id = (typeof request['id'] === 'string' || typeof request['id'] === 'number')
    ? request['id']
    : null;
  const method = typeof request['method'] === 'string' ? request['method'] : '';

  if (!method) {
    writeError(id, -32600, 'Invalid request: method is required.');
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'initialize') {
    writeResult(id ?? 0, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    });
    return;
  }

  if (method === 'tools/list') {
    writeResult(id ?? 0, {
      tools: TOOLS.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
    return;
  }

  if (method === 'tools/call') {
    const params = (request['params'] as Record<string, unknown> | undefined) ?? {};
    const toolName = typeof params['name'] === 'string' ? params['name'] : '';
    const toolArgs = params['arguments'];

    if (EXPLICITLY_DISALLOWED_TOOLS.has(toolName)) {
      writeResult(id ?? 0, {
        content: [{
          type: 'text',
          text: `Tool '${toolName}' is not available in Babel MCP Phase 1.`,
        }],
        isError: true,
      });
      return;
    }

    if (!TOOL_NAMES.has(toolName)) {
      writeError(id, -32601, `Unknown tool '${toolName}'.`);
      return;
    }

    const tool = TOOLS.find(candidate => candidate.name === toolName)!;
    try {
      const result = await tool.handler(toolArgs);
      writeResult(id ?? 0, {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
        structuredContent: result,
        isError: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeResult(id ?? 0, {
        content: [{
          type: 'text',
          text: message,
        }],
        isError: true,
      });
    }
    return;
  }

  writeError(id, -32601, `Method '${method}' is not supported.`);
}

export async function runBabelMcpServer(): Promise<void> {
  process.stdin.resume();
  let buffer = Buffer.alloc(0);

  process.stdin.on('data', async chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const headerText = buffer.subarray(0, headerEnd).toString('utf8');
      const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!contentLengthMatch) {
        buffer = Buffer.alloc(0);
        return;
      }

      const contentLength = Number.parseInt(contentLengthMatch[1]!, 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) {
        return;
      }

      const payload = buffer.subarray(messageStart, messageEnd).toString('utf8');
      buffer = buffer.subarray(messageEnd);

      try {
        const request = JSON.parse(payload) as Record<string, unknown>;
        await handleRequest(request);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeError(null, -32700, `Parse error: ${message}`);
      }
    }
  });
}
