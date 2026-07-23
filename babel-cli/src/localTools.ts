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

import path from 'node:path';
import { z } from 'zod';
import { SafeExecutor } from './sandbox.js';
import type { ToolResult, ExecutorMode } from './sandbox.js';
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
  handleGlobTool,
  handleGrepTool,
  handleWorkspaceSymbolSearch,
  handleWorkspaceMapTool,
  getApprovedReadRoots,
} from './tools/repoSearch.js';
import { handleGitContextTool } from './tools/gitContext.js';
import {
  handleGetCodeOutline,
  handleFindCodeDefinition,
  handleFindCodeReferences,
  handleLoadSkillManifest,
} from './tools/astTools.js';
import { handleLspTool, LspToolInputSchema } from './tools/lspTool.js';
import { getManifestSnapshot } from './tools/toolManifest.js';
import { getSessionCache } from './tools/toolResultCache.js';
import { getSessionGate } from './services/searchDepthGate.js';
import {
  createExecutorToolRegistry,
  type ExecutorToolDefinition,
  type ExecutorToolSnapshot,
} from './tools/executorRegistry.js';
import { EXECUTOR_TOOL_NAMES } from './tools/toolContracts.js';
import { LSP_OPERATIONS } from './services/lsp/types.js';
import { enforceActiveTaskEnvelope, type EnvelopeBlockResult } from './schemas/taskEnvelope.js';
import { getCircuitBreakerState, resetCircuitBreakerForRun } from './agent/toolExecutor.js';
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
  releaseLock,
} from './utils/locking.js';

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import { InputCoordinator, captureRawKeypress } from './ui/inputCoordinator.js';
import { getActiveRenderer } from './ui/waterfall.js';
import { ConfirmDialog } from './ui/dialog.js';
import { isRunningInDaemon } from './daemon/client.js';
import { logContext } from './pipeline/logging.js';
import { isPathInside } from './services/targetResolver.js';
import { CodeGraphBackend } from './services/codeGraphBackend.js';
import {
  renderCallPathTree,
  renderImpactPanel,
  renderArchitectureDashboard,
} from './ui/kgRenderers.js';

export type { ToolResult };

export interface ToolContext {
  agentId: string;
  runId: string;
  runDir?: string;
  babelRoot: string;
  /** Optional turn/session cancellation propagated to foreground child processes. */
  signal?: AbortSignal;
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
      return parsed.map((value) => String(value ?? '').trim()).filter((value) => value.length > 0);
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
  const normalizedRelativeTarget = path
    .relative(projectRoot, path.resolve(projectRoot, targetPath))
    .replace(/\\/g, '/')
    .toLowerCase();

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

function readToolPolicyList(
  envName: 'BABEL_ALLOWED_TOOLS' | 'BABEL_DISALLOWED_TOOLS',
): Set<string> {
  const raw = process.env[envName]?.trim();
  if (!raw) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(
        parsed
          .map((value) =>
            String(value ?? '')
              .trim()
              .toLowerCase(),
          )
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
    tool: z.literal('file_write'),
    path: z.string().min(1),
    content: z.string(),
  }),
  z.object({
    tool: z.literal('shell_exec'),
    command: z.string().min(1),
    working_directory: z.string().optional(),
    timeout_seconds: z.number().int().optional(),
  }),
  z.object({
    tool: z.literal('test_run'),
    command: z.string().min(1),
    working_directory: z.string().optional(),
    timeout_seconds: z.number().int().optional(),
  }),
  z.object({
    tool: z.literal('mcp_request'),
    server: z.string().min(1),
    query: z.string().min(1),
  }),
  z.object({
    tool: z.literal('mcp_resource_list'),
    server: z.string().min(1),
  }),
  z.object({
    tool: z.literal('mcp_resource_read'),
    server: z.string().min(1),
    uri: z.string().min(1),
  }),
  z.object({
    tool: z.literal('mcp_prompt_list'),
    server: z.string().min(1),
  }),
  z.object({
    tool: z.literal('mcp_prompt_get'),
    server: z.string().min(1),
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    tool: z.literal('mcp_tool_search'),
    server: z.string().min(1),
    query: z.string().optional(),
    limit: z.number().int().optional(),
    schema_limit: z.number().int().optional(),
  }),
  z.object({
    tool: z.literal('web_search'),
    query: z.string().min(1),
    max_results: z.number().int().optional(),
  }),
  z.object({
    tool: z.literal('web_fetch'),
    url: z.string().min(1),
    max_bytes: z.number().int().optional(),
  }),
  z.object({
    tool: z.literal('plugin_tool'),
    plugin: z.string().min(1),
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    tool: z.literal('audit_ui'),
    url: z.string().min(1),
    run_id: z.string().min(1),
  }),
  z.object({
    tool: z.literal('memory_store'),
    key: z.string().min(1),
    value: z.string(),
  }),
  z.object({
    tool: z.literal('memory_query'),
    key: z.string().min(1),
  }),
  z.object({
    tool: z.literal('enter_plan_mode'),
  }),
  z.object({
    tool: z.literal('exit_plan_mode'),
  }),
  z.object({
    tool: z.literal('semantic_search'),
    query: z.string().min(1),
    limit: z.number().int().optional(),
  }),
  z.object({
    tool: z.literal('grep'),
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    ignore_case: z.boolean().optional(),
    max_matches: z.number().int().optional(),
    output_format: z.enum(['text', 'json']).optional(),
    context_lines: z.number().int().min(0).max(10).optional(),
  }),
  z.object({
    tool: z.literal('glob'),
    pattern: z.string().min(1),
    max_paths: z.number().int().optional(),
    output_format: z.enum(['text', 'json']).optional(),
  }),
  z.object({
    tool: z.literal('workspace_symbol_search'),
    query: z.string().min(1),
    max_matches: z.number().int().optional(),
  }),
  z.object({
    tool: z.literal('workspace_map'),
    max_depth: z.number().int().optional(),
    max_files: z.number().int().optional(),
    output_format: z.enum(['text', 'json']).optional(),
  }),
  z.object({
    tool: z.literal('get_code_outline'),
    path: z.string().min(1),
  }),
  z.object({
    tool: z.literal('find_code_definition'),
    symbol: z.string().min(1),
  }),
  z.object({
    tool: z.literal('find_code_references'),
    symbol: z.string().min(1),
    max_matches: z.number().int().optional(),
  }),
  z.object({
    tool: z.literal('load_skill_manifest'),
    skill_id: z.string().min(1),
  }),
  z.object({
    tool: z.literal('git_context'),
    format: z.enum(['summary', 'files', 'diff']).optional(),
    path: z.string().optional(),
    max_lines: z.number().int().optional(),
    output_format: z.enum(['text', 'json']).optional(),
  }),
  z.object({
    tool: z.literal('acquire_lock'),
    path: z.string().min(1),
    reason: z.string().min(1),
    ttl_sec: z.number().int().optional(),
  }),
  z.object({
    tool: z.literal('release_lock'),
    path: z.string().min(1),
  }),
  z.object({
    tool: z.literal('tool_catalog'),
    category: z.string().optional(),
    mutating: z.boolean().optional(),
    format: z.enum(['summary', 'full']).optional(),
  }),
  z.object({
    tool: z.literal('file_delete'),
    path: z.string().min(1),
  }),
  z.object({
    tool: z.literal('git_reset'),
    target: z.string().optional(),
    hard: z.boolean().optional(),
  }),
  z.object({
    tool: z.literal('git_push'),
    remote: z.string().optional(),
    branch: z.string().optional(),
    force: z.boolean().optional(),
  }),
  z.object({
    tool: z.literal('kg_trace_path'),
    symbol: z.string().min(1),
    direction: z.enum(['inbound', 'outbound', 'both']).optional(),
    max_depth: z.number().int().min(1).max(10).optional(),
  }),
  z.object({
    tool: z.literal('kg_search_graph'),
    query: z.string().min(1),
    kind: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  z
    .object({
      tool: z.literal('kg_impact_analysis'),
      files: z.array(z.string()).optional(),
      symbol: z.string().optional(),
      depth: z.number().int().min(1).max(10).optional(),
    })
    .refine((data) => data.files !== undefined || data.symbol !== undefined, {
      message: 'At least one of files or symbol is required for impact analysis',
    }),
  z.object({
    tool: z.literal('kg_architecture'),
    scope: z.string().optional(),
    detail: z.enum(['summary', 'full']).optional(),
  }),
  z.object({
    tool: z.literal('kg_index_status'),
  }),
  z.object({
    tool: z.literal('lsp'),
    operation: z.enum(LSP_OPERATIONS).describe('The LSP operation to perform'),
    filePath: z.string().min(1).describe('Path to the file to analyze'),
    line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Line number (1-based, required for position-based operations)'),
    character: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Character offset (1-based, required for position-based operations)'),
    query: z
      .string()
      .optional()
      .describe('Search query (used by workspaceSymbol)'),
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

function handleFileRead(req: Extract<ToolCallRequest, { tool: 'file_read' }>): ToolResult {
  // file_read is always live — reading is non-destructive.
  return getExecutor().fileRead(req.path);
}

function handleFileWrite(req: Extract<ToolCallRequest, { tool: 'file_write' }>): ToolResult {
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
      `  [DRY RUN] file_write → ${req.path}` + ` (${req.content.length} chars — not written)`,
    );
    return {
      exit_code: 0,
      stdout: `[DRY RUN] Would write ${req.content.length} chars to: ${req.path}`,
      stderr: '',
    };
  }

  return getExecutor().fileWrite(req.path, req.content);
}

function handleFileDelete(req: Extract<ToolCallRequest, { tool: 'file_delete' }>): ToolResult {
  refreshDryRunState();
  if (DRY_RUN) {
    console.log(`  [DRY RUN] file_delete → ${req.path}`);
    return {
      exit_code: 0,
      stdout: `[DRY RUN] Would delete: ${req.path}`,
      stderr: '',
    };
  }
  return getExecutor().fileDelete(req.path);
}

async function handleGitReset(
  req: Extract<ToolCallRequest, { tool: 'git_reset' }>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  refreshDryRunState();
  const target = req.target ?? '';
  const hardFlag = req.hard === true ? ' --hard' : '';
  const command = `git reset${hardFlag}${target ? ` ${target}` : ''}`;
  if (DRY_RUN) {
    console.log(`  [DRY RUN] git_reset → ${command.trim()}`);
    return {
      exit_code: 0,
      stdout: `[DRY RUN] Would execute: ${command.trim()}`,
      stderr: '',
    };
  }
  return getExecutor().shellExecAsync(
    command.trim(),
    getExecutorProjectRoot(),
    30_000,
    'shell_exec',
    signal,
  );
}

async function handleGitPush(
  req: Extract<ToolCallRequest, { tool: 'git_push' }>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  refreshDryRunState();
  const remote = req.remote ?? 'origin';
  const branch = req.branch ?? '';
  const forceFlag = req.force === true ? ' --force' : '';
  const command = `git push${forceFlag} ${remote}${branch ? ` ${branch}` : ''}`;
  if (DRY_RUN) {
    console.log(`  [DRY RUN] git_push → ${command.trim()}`);
    return {
      exit_code: 0,
      stdout: `[DRY RUN] Would execute: ${command.trim()}`,
      stderr: '',
    };
  }
  return getExecutor().shellExecAsync(
    command.trim(),
    getExecutorProjectRoot(),
    60_000,
    'shell_exec',
    signal,
  );
}

async function handleShellExec(
  req: Extract<ToolCallRequest, { tool: 'shell_exec' }>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  refreshDryRunState();
  if (DRY_RUN) {
    console.log(`  [DRY RUN] shell_exec → ${req.command}`);
    return {
      exit_code: 0,
      stdout: `[DRY RUN] Would execute: ${req.command}`,
      stderr: '',
    };
  }

  return getExecutor().shellExecAsync(
    req.command,
    req.working_directory ?? getExecutorProjectRoot(),
    (req.timeout_seconds ?? 120) * 1000,
    'shell_exec',
    signal,
  );
}

async function handleTestRun(
  req: Extract<ToolCallRequest, { tool: 'test_run' }>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  refreshDryRunState();
  if (DRY_RUN) {
    console.log(`  [DRY RUN] test_run → ${req.command}`);
    return {
      exit_code: 0,
      stdout: `[DRY RUN] Would run tests: ${req.command}`,
      stderr: '',
    };
  }

  return getExecutor().testRunAsync(
    req.command,
    req.working_directory ?? getExecutorProjectRoot(),
    (req.timeout_seconds ?? 300) * 1000,
    signal,
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
    stdout:
      'Entered Plan Mode. Mutating tools are now restricted. Use exit_plan_mode when your design is ready.',
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

// ─── tool_catalog handler ──────────────────────────────────────────────────

function handleToolCatalog(req: Extract<ToolCallRequest, { tool: 'tool_catalog' }>): ToolResult {
  const snapshot = getManifestSnapshot();

  let filtered = snapshot;

  // Filter by category if specified
  if (req.category) {
    filtered = filtered.filter((t) => t.category === req.category);
  }

  // Filter by mutating status if specified
  if (req.mutating !== undefined) {
    filtered = filtered.filter((t) => t.mutating === req.mutating);
  }

  const format = req.format ?? 'summary';

  if (format === 'full') {
    // Full format: include all fields, examples, and input contracts
    const entries = filtered.map((t) => ({
      name: t.name,
      category: t.category,
      description: t.description,
      mutating: t.mutating,
      dryRunBehavior: t.dryRunBehavior,
      policyTags: t.policyTags,
      input: {
        required: t.input.required,
        optional: t.input.optional,
      },
      ...(t.jitApproval !== undefined ? { jitApproval: t.jitApproval } : {}),
      ...(t.examples ? { examples: t.examples } : {}),
    }));

    return {
      exit_code: 0,
      stdout: JSON.stringify({ tools: entries, count: entries.length }, null, 2),
      stderr: '',
    };
  }

  // Summary format: name, category, description, mutating, key params
  const entries = filtered.map((t) => ({
    name: t.name,
    category: t.category,
    description: t.description,
    mutating: t.mutating,
    requiredParams: t.input.required.map((f) => f.name),
    optionalParams: t.input.optional.map((f) => f.name),
  }));

  return {
    exit_code: 0,
    stdout: JSON.stringify({ tools: entries, count: entries.length }, null, 2),
    stderr: '',
  };
}

// ─── Knowledge graph tool handlers ───────────────────────────────────────────

const _codeGraphBackend = new CodeGraphBackend();

async function handleKgTracePath(
  req: Extract<ToolCallRequest, { tool: 'kg_trace_path' }>,
): Promise<ToolResult> {
  try {
    const result = await _codeGraphBackend.tracePath(
      req.symbol,
      req.direction ?? 'both',
      req.max_depth,
    );
    const width = 80;
    const rendered =
      result.edges.length > 0
        ? renderCallPathTree(result.edges, width, req.symbol)
        : 'No call paths found for symbol.';
    return {
      exit_code: 0,
      stdout: JSON.stringify({ data: result, rendered }, null, 2),
      stderr: '',
    };
  } catch (err) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleKgSearchGraph(
  req: Extract<ToolCallRequest, { tool: 'kg_search_graph' }>,
): Promise<ToolResult> {
  try {
    const result = await _codeGraphBackend.searchGraph(req.query, req.kind, req.limit);
    return {
      exit_code: 0,
      stdout: JSON.stringify({ data: result }, null, 2),
      stderr: '',
    };
  } catch (err) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleKgImpactAnalysis(
  req: Extract<ToolCallRequest, { tool: 'kg_impact_analysis' }>,
): Promise<ToolResult> {
  try {
    const result = await _codeGraphBackend.impactAnalysis(req.files, req.symbol, req.depth);
    const width = 80;
    const rendered =
      result.hops.length > 0 ? renderImpactPanel(result.hops, width) : 'No impact detected.';
    return {
      exit_code: 0,
      stdout: JSON.stringify({ data: result, rendered }, null, 2),
      stderr: '',
    };
  } catch (err) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleKgArchitecture(
  req: Extract<ToolCallRequest, { tool: 'kg_architecture' }>,
): Promise<ToolResult> {
  try {
    const result = await _codeGraphBackend.getArchitecture(req.scope, req.detail);
    const width = 80;
    const rendered = renderArchitectureDashboard(result, width);
    return {
      exit_code: 0,
      stdout: JSON.stringify({ data: result, rendered }, null, 2),
      stderr: '',
    };
  } catch (err) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleKgIndexStatus(): Promise<ToolResult> {
  try {
    const result = await _codeGraphBackend.getIndexStatus();
    return {
      exit_code: 0,
      stdout: JSON.stringify({ data: result }, null, 2),
      stderr: '',
    };
  } catch (err) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Executor tool definitions ───────────────────────────────────────────────

const EXECUTOR_TOOL_DEFINITIONS = [
  {
    name: 'directory_list',
    category: 'filesystem',
    description: 'List files and directories inside the active project root.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['read', 'filesystem'],
    input: { required: ['path'], optional: [] },
    handler: (req) =>
      handleDirectoryList(req as Extract<ToolCallRequest, { tool: 'directory_list' }>),
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
    name: 'file_delete',
    category: 'filesystem',
    description: 'Delete a file inside the active project root (soft-delete to .babel-trash/).',
    mutating: true,
    dryRunBehavior: 'mocked',
    policyTags: ['write', 'filesystem', 'destructive'],
    input: { required: ['path'], optional: [] },
    handler: (req) => handleFileDelete(req as Extract<ToolCallRequest, { tool: 'file_delete' }>),
  },
  {
    name: 'git_reset',
    category: 'vcs',
    description: 'Reset git state (working tree, index, or specific ref).',
    mutating: true,
    dryRunBehavior: 'mocked',
    policyTags: ['execute', 'vcs', 'destructive'],
    input: { required: [], optional: ['target', 'hard'] },
    handler: (req, context) =>
      handleGitReset(req as Extract<ToolCallRequest, { tool: 'git_reset' }>, context.signal),
  },
  {
    name: 'git_push',
    category: 'vcs',
    description: 'Push commits to a remote repository.',
    mutating: true,
    dryRunBehavior: 'mocked',
    policyTags: ['execute', 'vcs', 'destructive', 'network'],
    input: { required: [], optional: ['remote', 'branch', 'force'] },
    handler: (req, context) =>
      handleGitPush(req as Extract<ToolCallRequest, { tool: 'git_push' }>, context.signal),
  },
  {
    name: 'shell_exec',
    category: 'process',
    description: 'Execute an allowlisted shell command inside the active project root.',
    mutating: true,
    dryRunBehavior: 'mocked',
    policyTags: ['execute', 'shell'],
    input: { required: ['command'], optional: ['working_directory', 'timeout_seconds'] },
    handler: (req, context) =>
      handleShellExec(req as Extract<ToolCallRequest, { tool: 'shell_exec' }>, context.signal),
  },
  {
    name: 'test_run',
    category: 'process',
    description: 'Run an allowlisted test command with a longer default timeout.',
    mutating: true,
    dryRunBehavior: 'mocked',
    policyTags: ['execute', 'test'],
    input: { required: ['command'], optional: ['working_directory', 'timeout_seconds'] },
    handler: (req, context) =>
      handleTestRun(req as Extract<ToolCallRequest, { tool: 'test_run' }>, context.signal),
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
    handler: (req) =>
      handleMcpResourceList(req as Extract<ToolCallRequest, { tool: 'mcp_resource_list' }>),
  },
  {
    name: 'mcp_resource_read',
    category: 'mcp',
    description: 'Read a resource exposed by a configured MCP server.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['mcp', 'external', 'read'],
    input: { required: ['server', 'uri'], optional: [] },
    handler: (req) =>
      handleMcpResourceRead(req as Extract<ToolCallRequest, { tool: 'mcp_resource_read' }>),
  },
  {
    name: 'mcp_prompt_list',
    category: 'mcp',
    description: 'List prompts exposed by a configured MCP server.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['mcp', 'external', 'read'],
    input: { required: ['server'], optional: [] },
    handler: (req) =>
      handleMcpPromptList(req as Extract<ToolCallRequest, { tool: 'mcp_prompt_list' }>),
  },
  {
    name: 'mcp_prompt_get',
    category: 'mcp',
    description: 'Fetch a prompt from a configured MCP server.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['mcp', 'external', 'read'],
    input: { required: ['server', 'name'], optional: ['arguments'] },
    handler: (req) =>
      handleMcpPromptGet(req as Extract<ToolCallRequest, { tool: 'mcp_prompt_get' }>),
  },
  {
    name: 'mcp_tool_search',
    category: 'mcp',
    description: 'Search tools exposed by a configured MCP server.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['mcp', 'external', 'read'],
    input: { required: ['server'], optional: ['query', 'limit', 'schema_limit'] },
    handler: (req) =>
      handleMcpToolSearch(req as Extract<ToolCallRequest, { tool: 'mcp_tool_search' }>),
  },
  {
    name: 'web_search',
    category: 'web',
    description: 'Search the web with cache and public-network safeguards.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['web', 'external', 'read'],
    input: { required: ['query'], optional: ['max_results'] },
    handler: (req, context) =>
      handleWebSearch(req as Extract<ToolCallRequest, { tool: 'web_search' }>, context),
  },
  {
    name: 'web_fetch',
    category: 'web',
    description: 'Fetch a public web URL with cache and content safety labels.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['web', 'external', 'read'],
    input: { required: ['url'], optional: ['max_bytes'] },
    handler: (req, context) =>
      handleWebFetch(req as Extract<ToolCallRequest, { tool: 'web_fetch' }>, context),
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
    handler: (req) =>
      handleSemanticSearch(req as Extract<ToolCallRequest, { tool: 'semantic_search' }>),
  },
  {
    name: 'grep',
    category: 'search',
    description:
      'Search text files under the active project root for a regex pattern. Optionally include surrounding context lines with context_lines (max 10).',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['search', 'read', 'filesystem'],
    input: {
      required: ['pattern'],
      optional: ['path', 'ignore_case', 'max_matches', 'output_format', 'context_lines'],
    },
    handler: (req) => {
      const typedReq = req as Extract<ToolCallRequest, { tool: 'grep' }>;
      const approvedReadRoots = getApprovedReadRoots(getExecutorProjectRoot());
      return handleGrepTool(
        {
          pattern: typedReq.pattern,
          ...(typedReq.path !== undefined ? { path: typedReq.path } : {}),
          ...(typedReq.ignore_case !== undefined ? { ignore_case: typedReq.ignore_case } : {}),
          ...(typedReq.max_matches !== undefined ? { max_matches: typedReq.max_matches } : {}),
          ...(typedReq.output_format !== undefined
            ? { output_format: typedReq.output_format }
            : {}),
          ...(typedReq.context_lines !== undefined
            ? { context_lines: typedReq.context_lines }
            : {}),
        },
        approvedReadRoots,
      );
    },
  },
  {
    name: 'glob',
    category: 'search',
    description: 'List project-relative file paths that match a bounded glob pattern.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['search', 'read', 'filesystem'],
    input: { required: ['pattern'], optional: ['max_paths', 'output_format'] },
    handler: (req) => {
      const typedReq = req as Extract<ToolCallRequest, { tool: 'glob' }>;
      const approvedReadRoots = getApprovedReadRoots(getExecutorProjectRoot());
      return handleGlobTool(
        {
          pattern: typedReq.pattern,
          ...(typedReq.max_paths !== undefined ? { max_paths: typedReq.max_paths } : {}),
          ...(typedReq.output_format !== undefined
            ? { output_format: typedReq.output_format }
            : {}),
        },
        approvedReadRoots,
      );
    },
  },
  {
    name: 'workspace_symbol_search',
    category: 'search',
    description: 'Search project code files for symbol definitions matching a query.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['search', 'read', 'filesystem'],
    input: { required: ['query'], optional: ['max_matches'] },
    handler: (req) => {
      const typedReq = req as Extract<ToolCallRequest, { tool: 'workspace_symbol_search' }>;
      const approvedReadRoots = getApprovedReadRoots(getExecutorProjectRoot());
      return handleWorkspaceSymbolSearch(
        {
          query: typedReq.query,
          ...(typedReq.max_matches !== undefined ? { max_matches: typedReq.max_matches } : {}),
        },
        approvedReadRoots,
      );
    },
  },
  {
    name: 'workspace_map',
    category: 'search',
    description: 'Get a recursive directory tree of the workspace, respecting .gitignore.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['search', 'read'],
    input: { required: [], optional: ['max_depth', 'max_files', 'output_format'] },
    handler: (req) => {
      const typedReq = req as Extract<ToolCallRequest, { tool: 'workspace_map' }>;
      const approvedReadRoots = getApprovedReadRoots(getExecutorProjectRoot());
      return handleWorkspaceMapTool(
        {
          ...(typedReq.max_depth !== undefined ? { max_depth: typedReq.max_depth } : {}),
          ...(typedReq.max_files !== undefined ? { max_files: typedReq.max_files } : {}),
          ...(typedReq.output_format !== undefined
            ? { output_format: typedReq.output_format }
            : {}),
        },
        approvedReadRoots,
      );
    },
  },
  {
    name: 'git_context',
    category: 'search',
    description:
      'Show git status, diff, and uncommitted changes for the current repo. Non-mutating.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['search', 'read', 'git'],
    input: { required: [], optional: ['format', 'path', 'max_lines'] },
    handler: (req) => {
      const typedReq = req as Extract<ToolCallRequest, { tool: 'git_context' }>;
      return handleGitContextTool({
        ...(typedReq.format !== undefined ? { format: typedReq.format } : {}),
        ...(typedReq.path !== undefined ? { path: typedReq.path } : {}),
        ...(typedReq.max_lines !== undefined ? { max_lines: typedReq.max_lines } : {}),
        ...(typedReq.output_format !== undefined ? { output_format: typedReq.output_format } : {}),
      });
    },
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
      const lockRes = acquireLock(
        typedReq.path,
        context.babelRoot,
        context.agentId,
        context.runId,
        typedReq.reason,
        typedReq.ttl_sec,
      );
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
  {
    name: 'tool_catalog',
    category: 'search',
    description:
      'List all available executor tools with their input contracts, descriptions, and policy metadata. Supports optional category and mutating filters.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['read', 'meta', 'search'],
    input: { required: [], optional: ['category', 'mutating', 'format'] },
    handler: (req) => handleToolCatalog(req as Extract<ToolCallRequest, { tool: 'tool_catalog' }>),
  },
  {
    name: 'get_code_outline',
    category: 'search',
    description:
      'Reads a code file and returns a list of its classes, functions, methods, and interfaces with their line numbers. Read-only.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['search', 'read', 'filesystem'],
    input: { required: ['path'], optional: [] },
    handler: (req) => {
      const typedReq = req as Extract<ToolCallRequest, { tool: 'get_code_outline' }>;
      const approvedReadRoots = getApprovedReadRoots(getExecutorProjectRoot());
      return handleGetCodeOutline(typedReq.path, approvedReadRoots);
    },
  },
  {
    name: 'find_code_definition',
    category: 'search',
    description:
      'Search the codebase for the declaration and full body/block of a code symbol. Read-only. Has limitations extracting template literals or complex generics.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['search', 'read', 'filesystem'],
    input: { required: ['symbol'], optional: [] },
    handler: (req) => {
      const typedReq = req as Extract<ToolCallRequest, { tool: 'find_code_definition' }>;
      const approvedReadRoots = getApprovedReadRoots(getExecutorProjectRoot());
      return handleFindCodeDefinition(typedReq.symbol, approvedReadRoots);
    },
  },
  {
    name: 'find_code_references',
    category: 'search',
    description:
      'Locate references and usage occurrences of a symbol across codebase files, excluding its definition. Read-only.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['search', 'read', 'filesystem'],
    input: { required: ['symbol'], optional: ['max_matches'] },
    handler: (req) => {
      const typedReq = req as Extract<ToolCallRequest, { tool: 'find_code_references' }>;
      const approvedReadRoots = getApprovedReadRoots(getExecutorProjectRoot());
      return handleFindCodeReferences(typedReq.symbol, approvedReadRoots, typedReq.max_matches);
    },
  },
  {
    name: 'load_skill_manifest',
    category: 'search',
    description:
      'Retrieve the complete detailed instruction manual and system rules for a specific technical skill from the prompt catalog.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['read', 'search'],
    input: { required: ['skill_id'], optional: [] },
    handler: (req, context) => {
      const typedReq = req as Extract<ToolCallRequest, { tool: 'load_skill_manifest' }>;
      return handleLoadSkillManifest(typedReq.skill_id, context.babelRoot);
    },
  },
  {
    name: 'kg_trace_path',
    category: 'knowledge-graph',
    description:
      'Trace call paths for a symbol in the knowledge graph (inbound, outbound, or both). Shows callers and callees with file locations.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['search', 'read'],
    input: { required: ['symbol'], optional: ['direction', 'max_depth'] },
    handler: (req) => handleKgTracePath(req as Extract<ToolCallRequest, { tool: 'kg_trace_path' }>),
  },
  {
    name: 'kg_search_graph',
    category: 'knowledge-graph',
    description:
      'Search the knowledge graph for code symbols matching a query by name, kind, or pattern.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['search', 'read'],
    input: { required: ['query'], optional: ['kind', 'limit'] },
    handler: (req) =>
      handleKgSearchGraph(req as Extract<ToolCallRequest, { tool: 'kg_search_graph' }>),
  },
  {
    name: 'kg_impact_analysis',
    category: 'knowledge-graph',
    description:
      'Analyze the impact of changes to files or symbols with risk classification (HIGH/MEDIUM/LOW). Returns affected callers and callees grouped by hop distance.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['search', 'read'],
    input: { required: [], optional: ['files', 'symbol', 'depth'] },
    handler: (req) =>
      handleKgImpactAnalysis(req as Extract<ToolCallRequest, { tool: 'kg_impact_analysis' }>),
  },
  {
    name: 'kg_architecture',
    category: 'knowledge-graph',
    description:
      'Get a high-level architecture overview of the codebase: language breakdown, hotspot functions, and package structure.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['search', 'read'],
    input: { required: [], optional: ['scope', 'detail'] },
    handler: (req) =>
      handleKgArchitecture(req as Extract<ToolCallRequest, { tool: 'kg_architecture' }>),
  },
  {
    name: 'kg_index_status',
    category: 'knowledge-graph',
    description:
      'Check whether the knowledge graph has been indexed and is ready for structural queries. Returns node/edge counts when indexed.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['search', 'read'],
    input: { required: [], optional: [] },
    handler: () => handleKgIndexStatus(),
  },
  {
    name: 'lsp',
    category: 'search',
    description:
      'Query a Language Server Protocol (LSP) server for code intelligence: go-to-definition, find references, hover info, document/workspace symbols, go-to implementation. Spawns LSP servers lazily per file type. Read-only.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['search', 'read', 'lsp'],
    input: {
      required: ['operation', 'filePath'],
      optional: ['line', 'character', 'query'],
    },
    handler: (req) => {
      const typedReq = req as Extract<ToolCallRequest, { tool: 'lsp' }>;
      const input = LspToolInputSchema.parse({
        operation: typedReq.operation,
        filePath: typedReq.filePath,
        line: typedReq.line,
        character: typedReq.character,
        query: typedReq.query,
      });
      return handleLspTool(input);
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
function isControlPlaneFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  const controlPlanes = [
    '00_system_router/',
    '01_behavioral_os/',
    'prompt_catalog.yaml',
    'babel-cli/src/pipeline.ts',
    'babel-cli/src/compiler.ts',
    'babel-cli/src/schemas/agentcontracts.ts',
    'tools/resolve-control-plane.ps1',
  ];
  return controlPlanes.some((p) => norm.includes(p.toLowerCase()));
}

export function shouldJitApprove(req: ToolCallRequest): boolean {
  if (DRY_RUN) {
    return false;
  }

  let needsApproval = false;
  if (process.env['BABEL_ASK'] === 'true') {
    const snap = EXECUTOR_TOOL_REGISTRY.getSnapshot(req.tool);
    needsApproval =
      req.tool === 'file_write' ||
      req.tool === 'shell_exec' ||
      req.tool === 'test_run' ||
      req.tool === 'file_delete' ||
      req.tool === 'git_reset' ||
      req.tool === 'git_push' ||
      (snap !== null && snap !== undefined && snap.mutating === true);
  } else if (req.tool === 'file_write') {
    if (isControlPlaneFile(req.path)) {
      needsApproval = true;
    } else {
      const anchorPath = process.env['BABEL_ANCHOR_PATH'];
      if (anchorPath) {
        const projectRoot = getExecutorProjectRoot();
        const resolvedAnchor = path.resolve(projectRoot, anchorPath);
        const resolvedTarget = path.resolve(projectRoot, req.path);
        if (!isPathInside(resolvedAnchor, resolvedTarget)) {
          needsApproval = true;
        }
      }
      if (
        process.env['BABEL_RECOVERY_LOOP'] === 'true' ||
        process.env['BABEL_ROLLBACK_ON_FAIL'] === 'true'
      ) {
        needsApproval = true;
      }
    }
  } else if (req.tool === 'shell_exec' || req.tool === 'test_run') {
    if (
      process.env['BABEL_RECOVERY_LOOP'] === 'true' ||
      process.env['BABEL_ROLLBACK_ON_FAIL'] === 'true'
    ) {
      needsApproval = true;
    } else if (isControlPlaneFile(req.command)) {
      needsApproval = true;
    }
  }

  if (needsApproval) {
    const isNonInteractive = !process.stdin.isTTY || !!process.env['CI'];
    const isTest = process.env['BABEL_UNIT_TEST'] === 'true';
    if (isNonInteractive && !isTest) {
      throw new Error(
        `non_interactive_approval_required: Cannot prompt for JIT approval for ${req.tool} because stdin is non-interactive or CI is active.`,
      );
    }
    return true;
  }

  return false;
}

export async function promptUserJit(question: string): Promise<boolean> {
  const coordinator = InputCoordinator.getInstance();
  return coordinator.withLock('jit', async () => {
    const renderer = getActiveRenderer();
    renderer?.pauseTicks();
    coordinator.startBuffering();
    try {
      return await captureRawKeypress(question);
    } finally {
      const flushed = coordinator.stopBuffering();
      if (flushed) {
        process.stdout.write(flushed);
      }
      renderer?.resumeTicks();
    }
  });
}

export function renderGitDiff(
  req: Extract<ToolCallRequest, { tool: 'file_write' }>,
  context: ToolContext,
): string {
  const projectRoot = getExecutorProjectRoot();

  const existingFilePath = path.resolve(projectRoot, req.path);
  let existingSize = 0;
  let existingFileError: string | null = null;
  try {
    if (fs.existsSync(existingFilePath)) {
      existingSize = fs.statSync(existingFilePath).size;
    }
  } catch (err) {
    existingFileError = err instanceof Error ? err.message : String(err);
  }

  const proposedLength = req.content ? Buffer.byteLength(req.content, 'utf8') : 0;
  if (proposedLength > 500 * 1024 || existingSize > 500 * 1024) {
    const lineCount = req.content ? req.content.split(/\r?\n/).length : 0;
    return `[File Modified: Diff omitted for file over 500KB (Size: ${proposedLength} bytes, ${lineCount} lines proposed)]\n`;
  }

  const tempDir = context.runDir ?? path.join(projectRoot, 'runs', 'tmp');
  try {
    fs.mkdirSync(tempDir, { recursive: true });

    const tempFilePath = path.join(tempDir, `diff_${Date.now()}_${path.basename(req.path)}`);
    fs.writeFileSync(tempFilePath, req.content, 'utf-8');
    let file1 = existingFilePath;
    let file1IsTemp = false;

    if (!fs.existsSync(existingFilePath)) {
      const emptyFilePath = path.join(tempDir, `empty_${Date.now()}`);
      fs.writeFileSync(emptyFilePath, '', 'utf-8');
      file1 = emptyFilePath;
      file1IsTemp = true;
    }

    const gitResult = spawnSync(
      'git',
      ['diff', '--no-index', '--color', '--', file1, tempFilePath],
      {
        encoding: 'utf-8',
      },
    );

    try {
      fs.unlinkSync(tempFilePath);
    } catch (err) {
      // Phase 2b: Log cleanup failures instead of silently swallowing.
      // Permission errors or filesystem issues during cleanup should be visible.
      if (process.env['BABEL_DEBUG']) {
        console.warn(
          `[localTools] Failed to clean up temp file "${tempFilePath}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (file1IsTemp) {
      try {
        fs.unlinkSync(file1);
      } catch (err) {
        if (process.env['BABEL_DEBUG']) {
          console.warn(
            `[localTools] Failed to clean up empty file "${file1}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    return gitResult.stdout || '';
  } catch (err) {
    return `[Git Diff Error: ${err instanceof Error ? err.message : String(err)}]\n`;
  }
}

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

  // ── Phase 1a: Task envelope enforcement ─────────────────────────────
  const targetPath = 'path' in req && typeof req.path === 'string' ? req.path : undefined;
  const envelopeBlock = enforceActiveTaskEnvelope(req.tool, context.runId, targetPath);
  if (envelopeBlock) {
    return envelopeBlock;
  }

  // ── Phase 1b: Circuit breaker enforcement ───────────────────────────
  const breakerState = getCircuitBreakerState(context.runId);
  if (breakerState.tripped) {
    return {
      exit_code: 1,
      stdout: '',
      stderr:
        `[CIRCUIT_BREAKER] Session terminated: ${breakerState.consecutiveBlocks} consecutive policy blocks. ` +
        'This indicates the model is persistently attempting actions that policy disallows. ' +
        'Restart the session to reset the circuit breaker.',
    };
  }

  const policyDenied = maybeToolPolicyDenied(req.tool);
  if (policyDenied) {
    return policyDenied;
  }

  if (shouldJitApprove(req)) {
    const bus = logContext.getStore()?.eventBus;
    if (bus) {
      bus.promptPause('tool_jit_approval');
    }

    try {
      const isInteractive =
        process.stdout.isTTY && !process.env['CI'] && !process.env['BABEL_NON_INTERACTIVE'];
      let approved = false;
      const isDaemon = isRunningInDaemon();

      if (isDaemon && bus) {
        const id = 'jit-' + Math.random();
        approved = await new Promise<boolean>((resolve) => {
          bus.once(`jit_approval_response:${id}`, (data: { approved: boolean }) => {
            resolve(data.approved);
          });
          bus.emit('jit_approval_request', { id, req });
        });
      } else {
        if (req.tool === 'file_write') {
          const diff = renderGitDiff(req, context);
          if (isInteractive) {
            approved = await ConfirmDialog.show({
              title: 'Confirm File Write',
              message: `Do you want to allow writing changes to:\n  ${req.path}\n\n${diff || '(No differences detected or empty file)'}`,
              danger: false,
            });
          } else {
            let card = `\nProposed changes to ${req.path}:\n`;
            if (diff) {
              card += diff;
            } else {
              card += `  (No differences detected or empty file)\n`;
            }
            process.stdout.write(card);
            approved = await promptUserJit(`Allow this change? [y/N]: `);
          }
        } else if (
          req.tool === 'shell_exec' ||
          req.tool === 'test_run' ||
          req.tool === 'git_reset' ||
          req.tool === 'git_push' ||
          req.tool === 'file_delete'
        ) {
          const detail =
            req.tool === 'file_delete'
              ? `Delete File: ${req.path}`
              : req.tool === 'git_reset'
                ? `Git Reset: ${(req as any).target ?? 'working tree'}`
                : req.tool === 'git_push'
                  ? `Git Push: ${(req as any).target ?? 'remote'}`
                  : `Command:   ${req.command}\n  Directory: ${req.working_directory ?? process.cwd()}`;
          if (isInteractive) {
            approved = await ConfirmDialog.show({
              title: `Confirm ${req.tool}`,
              message: `Proposed dangerous tool execution:\n\n  ${detail}`,
              danger: true,
            });
          } else {
            process.stdout.write(`\n${detail}\n`);
            approved = await promptUserJit(`Allow this? [y/N]: `);
          }
        } else {
          if (isInteractive) {
            approved = await ConfirmDialog.show({
              title: `Confirm Tool: ${req.tool}`,
              message: `Proposed tool execution of "${req.tool}" with arguments:\n\n${JSON.stringify(req, null, 2)}`,
              danger: true,
            });
          } else {
            process.stdout.write(
              `\nProposed tool execution of "${req.tool}" with arguments:\n${JSON.stringify(req, null, 2)}\n`,
            );
            approved = await promptUserJit(`Allow this tool? [y/N]: `);
          }
        }
      }

      if (!approved) {
        if (bus) bus.promptResume();
        return {
          exit_code: 1,
          stdout: '',
          stderr:
            req.tool === 'file_write'
              ? `[JIT_DENIED] Write to ${req.path} denied by operator.`
              : `[JIT_DENIED] Tool execution denied by operator.`,
        };
      }
    } finally {
      if (bus) {
        bus.promptResume();
      }
    }
  }

  // ── Phase 4: Search-depth gate ──────────────────────────────────────────
  const gate = getSessionGate();
  const gateCheck = gate.checkBeforeCall(req.tool);
  if (!gateCheck.allowed) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `[SEARCH_DEPTH_GATE] ${gateCheck.reason ?? 'Insufficient search depth before mutation.'}`,
    };
  }

  // ── Phase 4: Tool result cache (read-only tools only) ────────────────────
  const MUTATION_TOOLS = new Set(['file_write', 'shell_exec', 'test_run']);
  if (!MUTATION_TOOLS.has(req.tool)) {
    const cache = getSessionCache();
    const cacheInput = extractCacheInput(req);
    const cached = cache.get(req.tool, cacheInput);
    if (cached) {
      gate.recordCall(req.tool, cached.exit_code);
      return cached;
    }
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────
  const projectRoot = getExecutorProjectRoot();
  const checkpoint = shouldCheckpointToolCall(req)
    ? createPreMutationCheckpoint(req, context, {
        dryRun: DRY_RUN,
        projectRoot,
        shadowRoot: process.env['BABEL_SHADOW_ROOT'] ?? null,
      })
    : null;

  const result = await EXECUTOR_TOOL_REGISTRY.dispatch(req, context);

  // ── Phase 4: Post-dispatch cache/gate updates ────────────────────────────
  gate.recordCall(req.tool, result.exit_code);

  if (!MUTATION_TOOLS.has(req.tool)) {
    const cache = getSessionCache();
    const cacheInput = extractCacheInput(req);
    cache.set(req.tool, cacheInput, result);
  } else {
    // Mutations invalidate the entire cache
    const cache = getSessionCache();
    cache.invalidateOnMutation(req.tool, result.exit_code);
  }

  // ── Finalize ─────────────────────────────────────────────────────────────
  const finalized = finalizeCheckpointAfterToolCall(checkpoint?.id ?? null, context);

  // ── Phase 1b: Reset circuit breaker on successful execution ──────────
  if (result.exit_code === 0) {
    resetCircuitBreakerForRun(context.runId);
  }

  if (!finalized) {
    return result;
  }

  return {
    ...result,
    checkpoint_ids: [...(result.checkpoint_ids ?? []), finalized.id],
  };
}

/**
 * Extract cache-relevant input fields from a tool call request.
 * Strips fields that don't affect the result (like internal metadata).
 */
function extractCacheInput(req: ToolCallRequest): Record<string, unknown> {
  const input: Record<string, unknown> = { ...req };
  // Remove tool name from input (it's part of the cache key already)
  delete input['tool'];
  return input;
}
