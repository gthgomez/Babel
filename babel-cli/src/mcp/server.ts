import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { inspectCatalog } from '../control-plane/stackResolver.js';
import { previewInstructionStackResolution } from '../control-plane/stackResolver.js';
import { getExecutorToolRegistrySnapshot } from '../localTools.js';
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

const ExecutorToolsListArgsSchema = z.object({
  include_mutating: z.boolean().optional(),
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

async function handleExecutorToolsList(args: unknown): Promise<unknown> {
  const parsed = ExecutorToolsListArgsSchema.parse(args ?? {});
  const includeMutating = parsed.include_mutating === true;
  const tools = getExecutorToolRegistrySnapshot()
    .filter((tool) => includeMutating || !tool.mutating)
    .map((tool) => ({
      ...tool,
      mcp_exposure: tool.mutating
        ? 'metadata_only_mutating_tool_not_callable'
        : 'metadata_only_read_only_tool',
    }));

  return {
    mode: includeMutating ? 'metadata_with_mutating_tools' : 'read_only_metadata_default',
    count: tools.length,
    mutating_metadata_included: includeMutating,
    note: includeMutating
      ? 'Mutating executor tools are listed as metadata only. Babel MCP cannot execute them.'
      : 'Default MCP executor metadata excludes mutating tools.',
    tools,
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
  {
    name: 'babel_executor_tools_list',
    description: 'List Babel executor tool registry metadata. Read-only and metadata-only; does not execute tools. Mutating metadata is hidden unless include_mutating is true.',
    inputSchema: {
      type: 'object',
      properties: {
        include_mutating: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: handleExecutorToolsList,
  },
];

const PROMPTS = [
  {
    name: 'babel_catalog_inspection',
    description: 'Guide a client to inspect Babel catalog entries using bounded filters.',
    arguments: [
      { name: 'project', description: 'Optional project filter.', required: false },
      { name: 'tags', description: 'Optional comma-delimited tags.', required: false },
    ],
  },
  {
    name: 'babel_stack_resolution',
    description: 'Guide a client to resolve an instruction stack before running a task.',
    arguments: [
      { name: 'domain', description: 'Target domain or project context.', required: false },
    ],
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
        resources: {},
        prompts: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    });
    return;
  }

  if (method === 'resources/list') {
    const entries = inspectCatalog(CATALOG_PATH, {});
    writeResult(id ?? 0, {
      resources: [
        {
          uri: 'babel://catalog/prompt_catalog',
          name: 'prompt_catalog.yaml',
          description: 'The Babel prompt catalog source file.',
          mimeType: 'text/yaml',
        },
        ...entries.slice(0, 50).map((entry) => ({
          uri: `babel://catalog/entry/${encodeURIComponent(entry.id)}`,
          name: entry.id,
          description: `${entry.layer} · ${entry.path}`,
          mimeType: 'application/json',
        })),
      ],
    });
    return;
  }

  if (method === 'resources/read') {
    const params = (request['params'] as Record<string, unknown> | undefined) ?? {};
    const uri = typeof params['uri'] === 'string' ? params['uri'] : '';
    if (uri === 'babel://catalog/prompt_catalog') {
      writeResult(id ?? 0, {
        contents: [{
          uri,
          mimeType: 'text/yaml',
          text: readFileSync(CATALOG_PATH, 'utf-8'),
        }],
      });
      return;
    }
    const entryPrefix = 'babel://catalog/entry/';
    if (uri.startsWith(entryPrefix)) {
      const entryId = decodeURIComponent(uri.slice(entryPrefix.length));
      const entry = inspectCatalog(CATALOG_PATH, { ids: [entryId] })[0];
      if (!entry) {
        writeError(id, -32602, `Unknown catalog entry resource '${entryId}'.`);
        return;
      }
      writeResult(id ?? 0, {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(asCatalogOutput(entry), null, 2),
        }],
      });
      return;
    }
    writeError(id, -32602, `Unknown resource URI '${uri}'.`);
    return;
  }

  if (method === 'prompts/list') {
    writeResult(id ?? 0, { prompts: PROMPTS });
    return;
  }

  if (method === 'prompts/get') {
    const params = (request['params'] as Record<string, unknown> | undefined) ?? {};
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    const args = (params['arguments'] as Record<string, unknown> | undefined) ?? {};
    if (!PROMPTS.some((prompt) => prompt.name === name)) {
      writeError(id, -32602, `Unknown prompt '${name}'.`);
      return;
    }
    const text = name === 'babel_catalog_inspection'
      ? [
          'Inspect the Babel prompt catalog using bounded filters.',
          `Project: ${String(args['project'] ?? 'any')}`,
          `Tags: ${String(args['tags'] ?? 'any')}`,
          'Use babel_catalog_inspect first; do not load unrelated catalog entries.',
        ].join('\n')
      : [
          'Resolve a Babel instruction stack before execution.',
          `Domain: ${String(args['domain'] ?? 'unspecified')}`,
          'Use babel_instruction_stack_preview before babel_stack_resolve when exploring.',
        ].join('\n');
    writeResult(id ?? 0, {
      description: PROMPTS.find((prompt) => prompt.name === name)?.description,
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text,
        },
      }],
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
          text: `Tool '${toolName}' is not registered by this read-only Babel MCP server.`,
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
    const chunkBuffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    buffer = Buffer.concat([buffer, chunkBuffer]);

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
