/**
 * localTools.ts — Safe Local Tool Executor
 *
 * Implements the executor tool contract surfaced by the local registry.
 *
 * DRY RUN MODE (default, or BABEL_DRY_RUN=true):
 *   Mutating operations log what WOULD have happened and return a synthetic
 *   success response. This lets us safely run the "Hello World" pipeline test
 *   against real prompts without touching the project codebase.
 *
 * LIVE MODE (BABEL_LIVE=true, or persisted dry-mode off):
 *   Mutating operations are executed for real via SafeExecutor (sandbox.ts),
 *   which enforces path traversal protection, a command whitelist, and
 *   shell-injection blocking. Activate only after validating dry-run output
 *   and confirming the SWE plan is safe.
 *
 * Zod schemas are exported so the pipeline executor loop can parse the CLI
 * Executor's tool call JSON against them before invoking `executeTool`.
 *
 * Environment variables:
 *   BABEL_DRY_RUN         Set to "true" to force dry-run mode.
 *   BABEL_LIVE            Set to "true" to opt into live mutation mode.
 *   BABEL_PROJECT_ROOT    Project root for SafeExecutor path resolution.
 *                         Defaults to process.cwd() if not set.
 */

import path                      from 'node:path';
import { z }                     from 'zod';
import { SafeExecutor }          from './sandbox.js';
import type { ToolResult, ExecutorMode }       from './sandbox.js';
import { isDryRunEnabled } from './config/dryRun.js';
import { readRuntimeMode, writeRuntimeMode } from './config/runtimeMode.js';
import { handleAuditUi } from './tools/auditUiTool.js';
import {
  handleMcpPromptGet,
  handleMcpPromptList,
  handleMcpRequest,
  handleMcpResourceList,
  handleMcpResourceRead,
  handleMcpToolSearch,
} from './tools/mcpTransport.js';
import { handleWebFetch, handleWebSearch } from './tools/webContext.js';
import { handlePluginTool } from './services/plugins.js';
import {
  handleMemoryQuery,
  handleMemoryStore,
  handleSemanticSearch,
} from './tools/chronicleMemory.js';
import {
  createExecutorToolRegistry,
  type ExecutorToolDefinition,
  type ExecutorToolSnapshot,
} from './tools/executorRegistry.js';
import { EXECUTOR_TOOL_NAMES } from './tools/toolContracts.js';
import {
  createPreMutationCheckpoint,
  finalizeCheckpointAfterToolCall,
  shouldCheckpointToolCall,
} from './services/checkpoints.js';
import {
  getWorkspaceLockPath,
  readLock,
  isLockActive,
  acquireLock,
  releaseLock
} from './utils/locking.js';

export type { ToolResult };

export interface ToolContext {
  agentId: string;
  runId: string;
  runDir?: string;
  babelRoot: string;
}

// ─── Dry-run gate ─────────────────────────────────────────────────────────────

export let DRY_RUN = isDryRunEnabled();

export function refreshDryRunState(): boolean {
  DRY_RUN = isDryRunEnabled();
  return DRY_RUN;
}

// ─── SafeExecutor factory ─────────────────────────────────────────────────────

/**
 * Creates a SafeExecutor rooted at the configured project root.
 * Called per-invocation in live mode; never called in dry-run mode.
 */
function getExecutor(): SafeExecutor {
  const root = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();
  const shadowRoot = process.env['BABEL_SHADOW_ROOT'] || null;
  const mode = readRuntimeMode();
  return new SafeExecutor(root, shadowRoot, mode);
}

function getExecutorProjectRoot(): string {
  return process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();
}

function getLockedFiles(): string[] {
  const raw = process.env['BABEL_LOCKED_FILES']?.trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((value) => String(value ?? '').trim())
        .filter((value) => value.length > 0);
    }
  } catch {
    // Fall through to a comma-delimited parse for backwards compatibility.
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function isLockedWritePath(targetPath: string): string | null {
  const lockedFiles = getLockedFiles();
  if (lockedFiles.length === 0) {
    return null;
  }

  const projectRoot = getExecutorProjectRoot();
  const normalizedTarget = path.resolve(projectRoot, targetPath).replace(/\\/g, '/').toLowerCase();
  const normalizedRelativeTarget = path.relative(projectRoot, path.resolve(projectRoot, targetPath)).replace(/\\/g, '/').toLowerCase();

  for (const lockedFile of lockedFiles) {
    const normalizedLocked = lockedFile.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    if (
      normalizedRelativeTarget === normalizedLocked ||
      normalizedRelativeTarget.endsWith(`/${normalizedLocked}`) ||
      normalizedTarget.endsWith(`/${normalizedLocked}`)
    ) {
      return lockedFile;
    }
  }

  return null;
}

function readToolPolicyList(envName: 'BABEL_ALLOWED_TOOLS' | 'BABEL_DISALLOWED_TOOLS'): Set<string> {
  const raw = process.env[envName]?.trim();
  if (!raw) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(
        parsed
          .map((value) => String(value ?? '').trim().toLowerCase())
          .filter((value) => value.length > 0),
      );
    }
  } catch {
    // Fall through to comma-delimited parsing.
  }

  return new Set(
    raw
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );
}

function maybeToolPolicyDenied(toolName: string): ToolResult | null {
  const normalizedTool = toolName.trim().toLowerCase();
  const disallowedTools = readToolPolicyList('BABEL_DISALLOWED_TOOLS');
  if (disallowedTools.has(normalizedTool)) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `[TOOL_POLICY] Tool "${toolName}" is disallowed by the effective tool policy.`,
      denial: {
        category: 'executor_policy',
        reason_code: 'tool_disallowed',
        message: `Tool "${toolName}" is disallowed by the effective tool policy.`,
        tool: toolName,
        active_mode: null,
        required_mode: null,
        evidence: [...disallowedTools],
      },
    };
  }

  const allowedTools = readToolPolicyList('BABEL_ALLOWED_TOOLS');
  if (allowedTools.size > 0 && !allowedTools.has(normalizedTool)) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `[TOOL_POLICY] Tool "${toolName}" is not in the allowed tool list.`,
      denial: {
        category: 'executor_policy',
        reason_code: 'tool_not_allowed',
        message: `Tool "${toolName}" is not in the allowed tool list.`,
        tool: toolName,
        active_mode: null,
        required_mode: null,
        evidence: [...allowedTools],
      },
    };
  }

  return null;
}

// ─── Tool call request schemas (discriminated on `tool`) ──────────────────────

export const ToolCallRequestSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('directory_list'),
    path: z.string().min(1),
  }),
  z.object({
    tool: z.literal('file_read'),
    path: z.string().min(1),
  }),
  z.object({
    tool:    z.literal('file_write'),
    path:    z.string().min(1),
    content: z.string(),
  }),
  z.object({
    tool:              z.literal('shell_exec'),
    command:           z.string().min(1),
    working_directory: z.string().optional(),
    timeout_seconds:   z.number().int().optional(),
  }),
  z.object({
    tool:              z.literal('test_run'),
    command:           z.string().min(1),
    working_directory: z.string().optional(),
    timeout_seconds:   z.number().int().optional(),
  }),
  z.object({
    tool:   z.literal('mcp_request'),
    server: z.string().min(1),
    query:  z.string().min(1),
  }),
  z.object({
    tool:   z.literal('mcp_resource_list'),
    server: z.string().min(1),
  }),
  z.object({
    tool:   z.literal('mcp_resource_read'),
    server: z.string().min(1),
    uri:    z.string().min(1),
  }),
  z.object({
    tool:   z.literal('mcp_prompt_list'),
    server: z.string().min(1),
  }),
  z.object({
    tool:      z.literal('mcp_prompt_get'),
    server:    z.string().min(1),
    name:      z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    tool:         z.literal('mcp_tool_search'),
    server:       z.string().min(1),
    query:        z.string().optional(),
    limit:        z.number().int().optional(),
    schema_limit: z.number().int().optional(),
  }),
  z.object({
    tool:        z.literal('web_search'),
    query:       z.string().min(1),
    max_results: z.number().int().optional(),
  }),
  z.object({
    tool:      z.literal('web_fetch'),
    url:       z.string().min(1),
    max_bytes: z.number().int().optional(),
  }),
  z.object({
    tool:      z.literal('plugin_tool'),
    plugin:    z.string().min(1),
    name:      z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    tool:   z.literal('audit_ui'),
    url:    z.string().min(1),
    run_id: z.string().min(1),
  }),
  z.object({
    tool:  z.literal('memory_store'),
    key:   z.string().min(1),
    value: z.string(),
  }),
  z.object({
    tool: z.literal('memory_query'),
    key:  z.string().min(1),
  }),
  z.object({
    tool: z.literal('enter_plan_mode'),
  }),
  z.object({
    tool: z.literal('exit_plan_mode'),
  }),
  z.object({
    tool:  z.literal('semantic_search'),
    query: z.string().min(1),
    limit: z.number().int().optional(),
  }),
  z.object({
    tool:    z.literal('acquire_lock'),
    path:    z.string().min(1),
    reason:  z.string().min(1),
    ttl_sec: z.number().int().optional(),
  }),
  z.object({
    tool: z.literal('release_lock'),
    path: z.string().min(1),
  }),
]);

export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;
export const TOOL_CALL_REQUEST_TOOL_NAMES = EXECUTOR_TOOL_NAMES;

// ─── Individual tool handlers ─────────────────────────────────────────────────

function handleDirectoryList(
  req: Extract<ToolCallRequest, { tool: 'directory_list' }>,
): ToolResult {
  // directory_list is always live — listing is non-destructive.
  return getExecutor().listDirectory(req.path);
}

function handleFileRead(
  req: Extract<ToolCallRequest, { tool: 'file_read' }>,
): ToolResult {
  // file_read is always live — reading is non-destructive.
  return getExecutor().fileRead(req.path);
}

function handleFileWrite(
  req: Extract<ToolCallRequest, { tool: 'file_write' }>,
): ToolResult {
  refreshDryRunState();
  const lockedFile = isLockedWritePath(req.path);
  if (lockedFile) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `[FILE_LOCK] Refusing to write locked file "${lockedFile}" via target "${req.path}".`,
    };
  }

  if (DRY_RUN) {
    if (process.env['BABEL_SHADOW_ROOT']) {
      const result = getExecutor().fileWrite(req.path, req.content);
      console.log(`  [DRY RUN] file_write → ${req.path} (${result.stdout})`);
      return {
        ...result,
        stdout: `[DRY RUN] ${result.stdout}`,
      };
    }

    console.log(
      `  [DRY RUN] file_write → ${req.path}` +
      ` (${req.content.length} chars — not written)`,
    );
    return {
      exit_code: 0,
      stdout:    `[DRY RUN] Would write ${req.content.length} chars to: ${req.path}`,
      stderr:    '',
    };
  }

  return getExecutor().fileWrite(req.path, req.content);
}

function handleShellExec(
  req: Extract<ToolCallRequest, { tool: 'shell_exec' }>,
): ToolResult {
  refreshDryRunState();
  if (DRY_RUN) {
    console.log(`  [DRY RUN] shell_exec → ${req.command}`);
    return {
      exit_code: 0,
      stdout:    `[DRY RUN] Would execute: ${req.command}`,
      stderr:    '',
    };
  }

  return getExecutor().shellExec(
    req.command,
    req.working_directory ?? process.cwd(),
    (req.timeout_seconds ?? 120) * 1000,
  );
}

function handleTestRun(
  req: Extract<ToolCallRequest, { tool: 'test_run' }>,
): ToolResult {
  refreshDryRunState();
  if (DRY_RUN) {
    console.log(`  [DRY RUN] test_run → ${req.command}`);
    return {
      exit_code: 0,
      stdout:    `[DRY RUN] Would run tests: ${req.command}`,
      stderr:    '',
    };
  }

  return getExecutor().testRun(
    req.command,
    req.working_directory ?? process.cwd(),
    (req.timeout_seconds ?? 300) * 1000,
  );
}


// Extracted tool handlers live under src/tools; localTools remains the public facade.

function handleEnterPlanMode(): ToolResult {
  const currentMode = readRuntimeMode();
  if (currentMode === 'plan') {
    return {
      exit_code: 0,
      stdout: 'Already in Plan Mode.',
      stderr: '',
    };
  }

  writeRuntimeMode('plan');
  console.log('  [MODE] Switched to Plan Mode');
  return {
    exit_code: 0,
    stdout: 'Entered Plan Mode. Mutating tools are now restricted. Use exit_plan_mode when your design is ready.',
    stderr: '',
  };
}

function handleExitPlanMode(): ToolResult {
  const currentMode = readRuntimeMode();
  if (currentMode === 'act') {
    return {
      exit_code: 0,
      stdout: 'Already in Act Mode.',
      stderr: '',
    };
  }

  writeRuntimeMode('act');
  console.log('  [MODE] Switched to Act Mode');
  return {
    exit_code: 0,
    stdout: 'Exited Plan Mode. Mutating tools are now enabled.',
    stderr: '',
  };
}

const EXECUTOR_TOOL_DEFINITIONS = [
  {
    name: 'directory_list',
    category: 'filesystem',
    description: 'List files and directories inside the active project root.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['read', 'filesystem'],
    input: { required: ['path'], optional: [] },
    handler: (req) => handleDirectoryList(req as Extract<ToolCallRequest, { tool: 'directory_list' }>),
  },
  {
    name: 'file_read',
    category: 'filesystem',
    description: 'Read a file inside the active project root.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['read', 'filesystem'],
    input: { required: ['path'], optional: [] },
    handler: (req) => handleFileRead(req as Extract<ToolCallRequest, { tool: 'file_read' }>),
  },
  {
    name: 'file_write',
    category: 'filesystem',
    description: 'Write a file inside the active project root, subject to locks and runtime mode.',
    mutating: true,
    dryRunBehavior: 'shadow_write',
    policyTags: ['write', 'filesystem'],
    input: { required: ['path', 'content'], optional: [] },
    handler: (req) => handleFileWrite(req as Extract<ToolCallRequest, { tool: 'file_write' }>),
  },
  {
    name: 'shell_exec',
    category: 'process',
    description: 'Execute an allowlisted shell command inside the active project root.',
    mutating: true,
    dryRunBehavior: 'mocked',
    policyTags: ['execute', 'shell'],
    input: { required: ['command'], optional: ['working_directory', 'timeout_seconds'] },
    handler: (req) => handleShellExec(req as Extract<ToolCallRequest, { tool: 'shell_exec' }>),
  },
  {
    name: 'test_run',
    category: 'process',
    description: 'Run an allowlisted test command with a longer default timeout.',
    mutating: true,
    dryRunBehavior: 'mocked',
    policyTags: ['execute', 'test'],
    input: { required: ['command'], optional: ['working_directory', 'timeout_seconds'] },
    handler: (req) => handleTestRun(req as Extract<ToolCallRequest, { tool: 'test_run' }>),
  },
  {
    name: 'mcp_request',
    category: 'mcp',
    description: 'Send a read-oriented JSON-RPC request to a configured MCP server.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['mcp', 'external'],
    input: { required: ['server', 'query'], optional: [] },
    handler: (req) => handleMcpRequest(req as Extract<ToolCallRequest, { tool: 'mcp_request' }>),
  },
  {
    name: 'mcp_resource_list',
    category: 'mcp',
    description: 'List resources exposed by a configured MCP server.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['mcp', 'external', 'read'],
    input: { required: ['server'], optional: [] },
    handler: (req) => handleMcpResourceList(req as Extract<ToolCallRequest, { tool: 'mcp_resource_list' }>),
  },
  {
    name: 'mcp_resource_read',
    category: 'mcp',
    description: 'Read a resource exposed by a configured MCP server.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['mcp', 'external', 'read'],
    input: { required: ['server', 'uri'], optional: [] },
    handler: (req) => handleMcpResourceRead(req as Extract<ToolCallRequest, { tool: 'mcp_resource_read' }>),
  },
  {
    name: 'mcp_prompt_list',
    category: 'mcp',
    description: 'List prompts exposed by a configured MCP server.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['mcp', 'external', 'read'],
    input: { required: ['server'], optional: [] },
    handler: (req) => handleMcpPromptList(req as Extract<ToolCallRequest, { tool: 'mcp_prompt_list' }>),
  },
  {
    name: 'mcp_prompt_get',
    category: 'mcp',
    description: 'Fetch a prompt from a configured MCP server.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['mcp', 'external', 'read'],
    input: { required: ['server', 'name'], optional: ['arguments'] },
    handler: (req) => handleMcpPromptGet(req as Extract<ToolCallRequest, { tool: 'mcp_prompt_get' }>),
  },
  {
    name: 'mcp_tool_search',
    category: 'mcp',
    description: 'Search tools exposed by a configured MCP server.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['mcp', 'external', 'read'],
    input: { required: ['server'], optional: ['query', 'limit', 'schema_limit'] },
    handler: (req) => handleMcpToolSearch(req as Extract<ToolCallRequest, { tool: 'mcp_tool_search' }>),
  },
  {
    name: 'web_search',
    category: 'web',
    description: 'Search the web with cache and public-network safeguards.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['web', 'external', 'read'],
    input: { required: ['query'], optional: ['max_results'] },
    handler: (req, context) => handleWebSearch(req as Extract<ToolCallRequest, { tool: 'web_search' }>, context),
  },
  {
    name: 'web_fetch',
    category: 'web',
    description: 'Fetch a public web URL with cache and content safety labels.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['web', 'external', 'read'],
    input: { required: ['url'], optional: ['max_bytes'] },
    handler: (req, context) => handleWebFetch(req as Extract<ToolCallRequest, { tool: 'web_fetch' }>, context),
  },
  {
    name: 'plugin_tool',
    category: 'plugin',
    description: 'Invoke an active read-only plugin tool.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['plugin', 'external'],
    input: { required: ['plugin', 'name'], optional: ['arguments'] },
    handler: (req, context) => {
      const typedReq = req as Extract<ToolCallRequest, { tool: 'plugin_tool' }>;
      return handlePluginTool(
        {
          tool: 'plugin_tool',
          plugin: typedReq.plugin,
          name: typedReq.name,
          input: typedReq.arguments,
        },
        {
          babelRoot: context.babelRoot,
        },
      );
    },
  },
  {
    name: 'audit_ui',
    category: 'ui',
    description: 'Run the UI audit helper against a URL for a Babel run.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['ui', 'audit'],
    input: { required: ['url', 'run_id'], optional: [] },
    handler: (req) => handleAuditUi(req as Extract<ToolCallRequest, { tool: 'audit_ui' }>),
  },
  {
    name: 'memory_store',
    category: 'memory',
    description: 'Store a project-scoped Chronicle memory fact.',
    mutating: true,
    dryRunBehavior: 'mocked',
    policyTags: ['memory', 'write'],
    input: { required: ['key', 'value'], optional: [] },
    handler: (req) => handleMemoryStore(req as Extract<ToolCallRequest, { tool: 'memory_store' }>),
  },
  {
    name: 'memory_query',
    category: 'memory',
    description: 'Query a project-scoped Chronicle memory fact or ALL facts.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['memory', 'read'],
    input: { required: ['key'], optional: [] },
    handler: (req) => handleMemoryQuery(req as Extract<ToolCallRequest, { tool: 'memory_query' }>),
  },
  {
    name: 'enter_plan_mode',
    category: 'mode',
    description: 'Switch the local executor runtime into plan mode.',
    mutating: true,
    dryRunBehavior: 'stateful',
    policyTags: ['mode', 'safety'],
    input: { required: [], optional: [] },
    handler: () => handleEnterPlanMode(),
  },
  {
    name: 'exit_plan_mode',
    category: 'mode',
    description: 'Switch the local executor runtime into act mode.',
    mutating: true,
    dryRunBehavior: 'stateful',
    policyTags: ['mode', 'safety'],
    input: { required: [], optional: [] },
    handler: () => handleExitPlanMode(),
  },
  {
    name: 'semantic_search',
    category: 'search',
    description: 'Search the local semantic index for relevant indexed context.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['search', 'read'],
    input: { required: ['query'], optional: ['limit'] },
    handler: (req) => handleSemanticSearch(req as Extract<ToolCallRequest, { tool: 'semantic_search' }>),
  },
  {
    name: 'acquire_lock',
    category: 'coordination',
    description: 'Acquire a workspace coordination lock for a path.',
    mutating: true,
    dryRunBehavior: 'stateful',
    policyTags: ['lock', 'coordination'],
    input: { required: ['path', 'reason'], optional: ['ttl_sec'] },
    handler: (req, context) => {
      refreshDryRunState();
      const typedReq = req as Extract<ToolCallRequest, { tool: 'acquire_lock' }>;
      if (DRY_RUN) {
        return {
          exit_code: 0,
          stdout: `[DRY RUN] Would acquire lock for ${typedReq.path}: ${typedReq.reason}`,
          stderr: '',
        };
      }
      const lockRes = acquireLock(typedReq.path, context.babelRoot, context.agentId, context.runId, typedReq.reason, typedReq.ttl_sec);
      return {
        exit_code: lockRes.success ? 0 : 1,
        stdout: lockRes.message,
        stderr: '',
      };
    },
  },
  {
    name: 'release_lock',
    category: 'coordination',
    description: 'Release a workspace coordination lock for a path.',
    mutating: true,
    dryRunBehavior: 'stateful',
    policyTags: ['lock', 'coordination'],
    input: { required: ['path'], optional: [] },
    handler: (req, context) => {
      refreshDryRunState();
      const typedReq = req as Extract<ToolCallRequest, { tool: 'release_lock' }>;
      if (DRY_RUN) {
        return {
          exit_code: 0,
          stdout: `[DRY RUN] Would release lock for ${typedReq.path}`,
          stderr: '',
        };
      }
      const relRes = releaseLock(typedReq.path, context.babelRoot, context.runId);
      return {
        exit_code: relRes.success ? 0 : 1,
        stdout: relRes.message,
        stderr: '',
      };
    },
  },
] satisfies readonly ExecutorToolDefinition[];

const EXECUTOR_TOOL_REGISTRY = createExecutorToolRegistry(EXECUTOR_TOOL_DEFINITIONS);

export function getExecutorToolRegistrySnapshot(): ExecutorToolSnapshot[] {
  return EXECUTOR_TOOL_REGISTRY.list();
}

export function getExecutorToolSnapshot(name: string): ExecutorToolSnapshot | null {
  return EXECUTOR_TOOL_REGISTRY.getSnapshot(name);
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Dispatches a parsed tool call request to the appropriate handler.
 * Returns a `ToolResult` suitable for injection back into the executor loop.
 *
 * `file_read` and `mcp_request` are always live (both are read-only).
 * All mutating tools are mocked in DRY RUN mode.
 *
 * Returns `Promise<ToolResult>` so that `mcp_request` (which performs async
 * stdio I/O) can be awaited cleanly alongside the synchronous handlers.
 */
export async function executeTool(req: ToolCallRequest, context: ToolContext): Promise<ToolResult> {
  refreshDryRunState();
  const policyDenied = maybeToolPolicyDenied(req.tool);
  if (policyDenied) {
    return policyDenied;
  }

  const projectRoot = getExecutorProjectRoot();
  const checkpoint = shouldCheckpointToolCall(req)
    ? createPreMutationCheckpoint(req, context, {
      dryRun: DRY_RUN,
      projectRoot,
      shadowRoot: process.env['BABEL_SHADOW_ROOT'] ?? null,
    })
    : null;

  const result = await EXECUTOR_TOOL_REGISTRY.dispatch(req, context);
  const finalized = finalizeCheckpointAfterToolCall(checkpoint?.id ?? null, context);
  if (!finalized) {
    return result;
  }

  return {
    ...result,
    checkpoint_ids: [...(result.checkpoint_ids ?? []), finalized.id],
  };
}
