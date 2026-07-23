import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { z } from 'zod';

import { BABEL_ROOT } from '../cli/constants.js';
import type { AgentSession } from '../agent/session.js';
import type { LiveSubagentSpec } from '../agent/session.js';

const AgentToolNameSchema = z.enum([
  'directory_list',
  'file_read',
  'file_write',
  'shell_exec',
  'test_run',
  'mcp_request',
  'mcp_resource_list',
  'mcp_resource_read',
  'mcp_prompt_list',
  'mcp_prompt_get',
  'mcp_tool_search',
  'web_search',
  'web_fetch',
  'plugin_tool',
  'audit_ui',
  'memory_store',
  'memory_query',
  'semantic_search',
]);

const AgentOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('note'),
    note: z.string().min(1),
  }),
  z.object({
    type: z.literal('read_file'),
    path: z.string().min(1),
    rationale: z.string().optional(),
  }),
  z.object({
    type: z.literal('write_file'),
    path: z.string().min(1),
    content: z.string(),
    rationale: z.string().min(1),
  }),
]);

const SubagentSpecSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/),
  role: z.string().min(1),
  task: z.string().min(1),
  allowed_tools: z.array(AgentToolNameSchema).default(['file_read']),
  disallowed_tools: z.array(AgentToolNameSchema).default([]),
  write_scope: z.array(z.string().min(1)).default([]),
  evidence_path: z.string().optional(),
  merge_strategy: z.enum(['auto_disjoint', 'manual', 'review_only']).optional(),
  operations: z.array(AgentOperationSchema).default([]),
  /** Model backend key override for live execution (e.g. "deepseek-v4-pro", "scout").
   *  When omitted, the sub-agent uses the default model. */
  model: z.string().optional(),
  /** When true, execute this spec with live LLM sub-agents instead of fixture operations. */
  live: z.boolean().optional(),
});

const AgentTeamSpecSchema = z.object({
  schema_version: z.literal(1),
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  name: z.string().min(1).optional(),
  project_root: z.string().min(1).optional(),
  isolation: z.enum(['copy', 'git_worktree', 'none']).default('git_worktree'),
  lead_synthesis: z.boolean().default(true),
  agents: z.array(SubagentSpecSchema).min(1),
});

export type AgentToolName = z.infer<typeof AgentToolNameSchema>;
export type AgentOperation = z.infer<typeof AgentOperationSchema>;
type ParsedSubagentSpec = z.infer<typeof SubagentSpecSchema>;
type ParsedAgentTeamSpec = z.infer<typeof AgentTeamSpecSchema>;
export type SubagentSpec = z.input<typeof SubagentSpecSchema>;
export type AgentTeamSpec = z.input<typeof AgentTeamSpecSchema>;
export type AgentIsolationMode = ParsedAgentTeamSpec['isolation'];
export type AgentRunStatus = 'ready_to_merge' | 'merged' | 'failed' | 'no_changes';

export interface AgentTeamOptions {
  babelRoot?: string;
  runsRoot?: string;
  projectRoot?: string;
  isolation?: AgentIsolationMode;
}

export interface AgentDiagnostic {
  severity: 'info' | 'warn' | 'fail';
  code: string;
  message: string;
  agent_id?: string | undefined;
  path?: string | undefined;
}

export interface AgentFileChange {
  path: string;
  rationale: string;
  before_hash: string | null;
  after_hash: string;
  bytes: number;
}

export interface SubagentEvidence {
  schema_version: 1;
  team_id: string;
  agent_id: string;
  role: string;
  task: string;
  allowed_tools: AgentToolName[];
  disallowed_tools: AgentToolName[];
  write_scope: string[];
  merge_strategy: 'auto_disjoint' | 'manual' | 'review_only';
  workspace_root: string;
  evidence_path: string;
  status: 'success' | 'failed';
  operations: Array<Record<string, unknown>>;
  changed_files: AgentFileChange[];
  diagnostics: AgentDiagnostic[];
  /** Model backend key used for this agent (e.g. "deepseek-v4-pro"). */
  model?: string;
}

export interface AgentLeadSynthesis {
  schema_version: 1;
  team_id: string;
  status: AgentRunStatus;
  merge_ready: boolean;
  execution_model: 'spec_contract_harness' | 'live_subagents';
  live_subagents: {
    enabled: boolean;
    required_before_live_subagents: string[];
    reason: string;
    live_execution_supported_since?: string;
  };
  summary: string;
  agents: Array<{
    id: string;
    role: string;
    status: string;
    merge_strategy: string;
    changed_files: string[];
    evidence_path: string;
  }>;
  conflicts: AgentDiagnostic[];
}

export interface AgentTeamRun {
  schema_version: 1;
  id: string;
  name: string;
  created_at: string;
  project_root: string;
  run_dir: string;
  isolation: AgentIsolationMode;
  execution_model: 'spec_contract_harness' | 'live_subagents';
  live_subagents: {
    enabled: boolean;
    required_before_live_subagents: string[];
    required_opt_in: string;
    isolation_required_for_mutation: boolean;
    evidence_required_for_merge: boolean;
    restore_path_required_before_merge: boolean;
    live_execution_supported_since?: string;
  };
  status: AgentRunStatus;
  spec: ParsedAgentTeamSpec;
  agents: SubagentEvidence[];
  diagnostics: AgentDiagnostic[];
  lead_synthesis: AgentLeadSynthesis;
  merge_report_path?: string | undefined;
}

export interface AgentRunSummary {
  id: string;
  name: string;
  status: AgentRunStatus;
  created_at: string;
  run_dir: string;
  project_root: string;
  agent_count: number;
}

export interface AgentRunIndex {
  schema_version: 1;
  runs: AgentRunSummary[];
}

export interface AgentMergeReport {
  schema_version: 1;
  team_id: string;
  merged_at: string;
  status: 'merged' | 'partial' | 'failed';
  merged_files: string[];
  skipped_agents: Array<{ agent_id: string; reason: string }>;
  diagnostics: AgentDiagnostic[];
  restore: AgentMergeRestorePlan;
}

export interface AgentMergeSnapshot {
  path: string;
  before_exists: boolean;
  backup_path: string | null;
  merged_exists: boolean;
  merged_hash: string | null;
}

export interface AgentMergeRestorePlan {
  available: boolean;
  backup_dir: string;
  snapshot_manifest_path: string;
  restore_command: string;
  inspect_command: string;
  notes: string[];
}

export interface AgentMergeRestoreReport {
  schema_version: 1;
  team_id: string;
  restored_at: string;
  status: 'restored' | 'failed';
  restored_files: string[];
  removed_created_files: string[];
  diagnostics: AgentDiagnostic[];
}

export interface SubagentIsolationContract {
  schema_version: 1;
  contract_id: 'babel.subagents.isolation';
  live_subagents_enabled: boolean;
  required_before_live_subagents: string[];
  live_execution_supported_since?: string;
  isolation_modes: AgentIsolationMode[];
  write_scope_policy: {
    declared_scope_required: true;
    overlapping_write_scopes_rejected: true;
    review_only_agents_cannot_write: true;
  };
  merge_policy: {
    evidence_required: true;
    auto_merge_requires_disjoint_scopes: true;
    rollback_path: 'pre_merge_project_files_plus_merge_report';
  };
}

function getBabelRoot(options: AgentTeamOptions = {}): string {
  return options.babelRoot ?? process.env['BABEL_ROOT'] ?? BABEL_ROOT;
}

export function getAgentRunsRoot(options: AgentTeamOptions = {}): string {
  return options.runsRoot ?? join(getBabelRoot(options), 'runs', 'agents');
}

function getAgentIndexPath(options: AgentTeamOptions = {}): string {
  return join(getAgentRunsRoot(options), 'agents.json');
}

function pad(num: number): string {
  return String(num).padStart(2, '0');
}

function formatRunTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'agent-team'
  );
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function readFileHash(path: string): string | null {
  if (!existsSync(path) || statSync(path).isDirectory()) {
    return null;
  }
  return hashContent(readFileSync(path, 'utf-8'));
}

function safeRelativePath(path: string): string {
  const normalized = path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^\.\/+/, '');
  if (!normalized || normalized === '.' || normalized.includes('\0')) {
    throw new Error(`Invalid relative path: ${path}`);
  }
  const parts = normalized.split('/');
  if (parts.includes('..')) {
    throw new Error(`Path traversal is not allowed: ${path}`);
  }
  return normalized;
}

function resolveInsideRoot(root: string, path: string): string {
  const relativePath = safeRelativePath(path);
  const target = resolve(root, relativePath);
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const rel = relative(normalizedRoot, normalizedTarget);
  if (
    rel.startsWith('..') ||
    rel === '..' ||
    rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(`Path escapes root: ${path}`);
  }
  return normalizedTarget;
}

function normalizeScopeEntry(entry: string): string {
  return safeRelativePath(entry).replace(/\/+$/g, '');
}

function scopeContainsPath(scope: string[], path: string): boolean {
  const normalizedPath = safeRelativePath(path);
  return scope.some((entry) => {
    const normalizedScope = normalizeScopeEntry(entry);
    return normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`);
  });
}

function scopesOverlap(left: string, right: string): boolean {
  const a = normalizeScopeEntry(left);
  const b = normalizeScopeEntry(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function operationTool(operation: AgentOperation): AgentToolName | 'note' {
  if (operation.type === 'read_file') return 'file_read';
  if (operation.type === 'write_file') return 'file_write';
  return 'note';
}

function normalizeSubagent(
  agent: ParsedSubagentSpec,
): ParsedSubagentSpec & { merge_strategy: 'auto_disjoint' | 'manual' | 'review_only' } {
  const hasWrites = agent.operations.some((operation) => operation.type === 'write_file');
  const roleLooksReadOnly = /review|audit|read/i.test(agent.role);
  const mergeStrategy =
    agent.merge_strategy ?? (hasWrites && !roleLooksReadOnly ? 'auto_disjoint' : 'review_only');
  return {
    ...agent,
    write_scope: agent.write_scope.map(normalizeScopeEntry),
    merge_strategy: mergeStrategy,
  };
}

function validateAgentPolicy(
  agent: ParsedSubagentSpec & { merge_strategy: 'auto_disjoint' | 'manual' | 'review_only' },
): AgentDiagnostic[] {
  const diagnostics: AgentDiagnostic[] = [];
  const allowed = new Set(agent.allowed_tools);
  const disallowed = new Set(agent.disallowed_tools);
  const readOnly = agent.merge_strategy === 'review_only';

  for (const operation of agent.operations) {
    const tool = operationTool(operation);
    if (tool === 'note') {
      continue;
    }
    if (allowed.size > 0 && !allowed.has(tool)) {
      diagnostics.push({
        severity: 'fail',
        code: 'tool_not_allowed',
        message: `Operation ${operation.type} requires ${tool}, but it is not in allowed_tools.`,
        agent_id: agent.id,
        path: 'path' in operation ? operation.path : undefined,
      });
    }
    if (disallowed.has(tool)) {
      diagnostics.push({
        severity: 'fail',
        code: 'tool_disallowed',
        message: `Operation ${operation.type} requires ${tool}, but it is listed in disallowed_tools.`,
        agent_id: agent.id,
        path: 'path' in operation ? operation.path : undefined,
      });
    }
    if (operation.type === 'write_file') {
      if (readOnly) {
        diagnostics.push({
          severity: 'fail',
          code: 'review_only_write_blocked',
          message: 'review_only subagents cannot write files.',
          agent_id: agent.id,
          path: operation.path,
        });
      }
      if (agent.write_scope.length === 0 || !scopeContainsPath(agent.write_scope, operation.path)) {
        diagnostics.push({
          severity: 'fail',
          code: 'write_scope_violation',
          message: `Write target "${operation.path}" is outside the subagent write_scope.`,
          agent_id: agent.id,
          path: operation.path,
        });
      }
    }
  }

  return diagnostics;
}

function validateDisjointWriteScopes(
  agents: Array<
    ParsedSubagentSpec & { merge_strategy: 'auto_disjoint' | 'manual' | 'review_only' }
  >,
): AgentDiagnostic[] {
  const diagnostics: AgentDiagnostic[] = [];
  const writableAgents = agents.filter(
    (agent) => agent.merge_strategy !== 'review_only' && agent.write_scope.length > 0,
  );

  for (let i = 0; i < writableAgents.length; i++) {
    for (let j = i + 1; j < writableAgents.length; j++) {
      const left = writableAgents[i]!;
      const right = writableAgents[j]!;
      for (const leftScope of left.write_scope) {
        for (const rightScope of right.write_scope) {
          if (scopesOverlap(leftScope, rightScope)) {
            diagnostics.push({
              severity: 'fail',
              code: 'write_scope_conflict',
              message: `Subagents "${left.id}" and "${right.id}" have overlapping write scopes: ${leftScope} / ${rightScope}.`,
              agent_id: `${left.id},${right.id}`,
            });
          }
        }
      }
    }
  }

  return diagnostics;
}

function copyScopedFiles(projectRoot: string, workspaceRoot: string, writeScope: string[]): void {
  mkdirSync(workspaceRoot, { recursive: true });
  for (const scope of writeScope) {
    const relativeScope = normalizeScopeEntry(scope);
    const source = resolveInsideRoot(projectRoot, relativeScope);
    const target = resolveInsideRoot(workspaceRoot, relativeScope);
    if (!existsSync(source)) {
      mkdirSync(dirname(target), { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, {
      recursive: true,
      force: true,
      filter: (sourcePath) => {
        const name = basename(sourcePath);
        return !['.git', 'node_modules', 'dist', 'runs'].includes(name);
      },
    });
  }
}

function createGitWorktree(projectRoot: string, workspaceRoot: string): void {
  const result = spawnSync('git', ['worktree', 'add', '--detach', workspaceRoot, 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`git worktree add failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function prepareWorkspace(
  agent: ParsedSubagentSpec & { merge_strategy: 'auto_disjoint' | 'manual' | 'review_only' },
  projectRoot: string,
  runDir: string,
  isolation: AgentIsolationMode,
): { workspaceRoot: string; mergeRequired: boolean } {
  const hasWrites = agent.operations.some((operation) => operation.type === 'write_file');
  if (!hasWrites || isolation === 'none') {
    return {
      workspaceRoot: projectRoot,
      mergeRequired: false,
    };
  }

  const workspaceRoot = join(runDir, 'workspaces', agent.id);
  if (existsSync(workspaceRoot)) {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }

  if (isolation === 'git_worktree') {
    createGitWorktree(projectRoot, workspaceRoot);
  } else {
    copyScopedFiles(projectRoot, workspaceRoot, agent.write_scope);
  }

  return {
    workspaceRoot,
    mergeRequired: true,
  };
}

function executeAgentOperations(
  teamId: string,
  agent: ParsedSubagentSpec & { merge_strategy: 'auto_disjoint' | 'manual' | 'review_only' },
  projectRoot: string,
  runDir: string,
  isolation: AgentIsolationMode,
): SubagentEvidence {
  const policyDiagnostics = validateAgentPolicy(agent);
  const evidencePath = agent.evidence_path
    ? join(runDir, safeRelativePath(agent.evidence_path))
    : join(runDir, 'subagents', agent.id, 'evidence.json');

  let workspaceRoot = projectRoot;
  let mergeRequired = false;
  const operationRecords: Array<Record<string, unknown>> = [];
  const changedFiles: AgentFileChange[] = [];
  const diagnostics: AgentDiagnostic[] = [...policyDiagnostics];

  try {
    const prepared = prepareWorkspace(agent, projectRoot, runDir, isolation);
    workspaceRoot = prepared.workspaceRoot;
    mergeRequired = prepared.mergeRequired;
  } catch (error) {
    diagnostics.push({
      severity: 'fail',
      code: 'workspace_isolation_failed',
      message: error instanceof Error ? error.message : String(error),
      agent_id: agent.id,
    });
  }

  if (!diagnostics.some((diagnostic) => diagnostic.severity === 'fail')) {
    for (const operation of agent.operations) {
      try {
        if (operation.type === 'note') {
          operationRecords.push({ type: 'note', note: operation.note });
          continue;
        }

        const targetPath = resolveInsideRoot(workspaceRoot, operation.path);
        if (operation.type === 'read_file') {
          const content =
            existsSync(targetPath) && !statSync(targetPath).isDirectory()
              ? readFileSync(targetPath, 'utf-8')
              : '';
          operationRecords.push({
            type: 'read_file',
            path: safeRelativePath(operation.path),
            bytes: content.length,
            ...(operation.rationale ? { rationale: operation.rationale } : {}),
          });
          continue;
        }

        const beforeHash = readFileHash(targetPath);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, operation.content, 'utf-8');
        const afterHash = hashContent(operation.content);
        const change: AgentFileChange = {
          path: safeRelativePath(operation.path),
          rationale: operation.rationale,
          before_hash: beforeHash,
          after_hash: afterHash,
          bytes: operation.content.length,
        };
        changedFiles.push(change);
        operationRecords.push({
          type: 'write_file',
          path: change.path,
          rationale: operation.rationale,
          before_hash: beforeHash,
          after_hash: afterHash,
          merge_required: mergeRequired,
        });
      } catch (error) {
        diagnostics.push({
          severity: 'fail',
          code: 'operation_failed',
          message: error instanceof Error ? error.message : String(error),
          agent_id: agent.id,
          path: 'path' in operation ? operation.path : undefined,
        });
      }
    }
  }

  const evidence: SubagentEvidence = {
    schema_version: 1,
    team_id: teamId,
    agent_id: agent.id,
    role: agent.role,
    task: agent.task,
    allowed_tools: agent.allowed_tools,
    disallowed_tools: agent.disallowed_tools,
    write_scope: agent.write_scope,
    merge_strategy: agent.merge_strategy,
    workspace_root: workspaceRoot,
    evidence_path: evidencePath,
    status: diagnostics.some((diagnostic) => diagnostic.severity === 'fail') ? 'failed' : 'success',
    operations: operationRecords,
    changed_files: changedFiles,
    diagnostics,
  };

  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf-8');
  return evidence;
}

function getLiveSubagentGateState(): {
  enabled: boolean;
  required_before_live_subagents: string[];
  required_opt_in: string;
  isolation_required_for_mutation: boolean;
  evidence_required_for_merge: boolean;
  restore_path_required_before_merge: boolean;
  live_execution_supported_since?: string;
} {
  const contract = buildSubagentIsolationContract();
  return {
    enabled: contract.live_subagents_enabled,
    required_before_live_subagents: contract.required_before_live_subagents,
    required_opt_in: contract.live_subagents_enabled
      ? 'enabled_via_buildSubagentIsolationContract'
      : 'future_explicit_live_subagents',
    isolation_required_for_mutation: true,
    evidence_required_for_merge: true,
    restore_path_required_before_merge: true,
    ...(contract.live_execution_supported_since
      ? { live_execution_supported_since: contract.live_execution_supported_since }
      : {}),
  };
}

function buildLeadSynthesis(
  teamId: string,
  agents: SubagentEvidence[],
  diagnostics: AgentDiagnostic[],
): AgentLeadSynthesis {
  const liveSubagentGateState = getLiveSubagentGateState();
  const failed =
    agents.some((agent) => agent.status === 'failed') ||
    diagnostics.some((diagnostic) => diagnostic.severity === 'fail');
  const changedCount = agents.reduce((sum, agent) => sum + agent.changed_files.length, 0);
  const status: AgentRunStatus = failed
    ? 'failed'
    : changedCount > 0
      ? 'ready_to_merge'
      : 'no_changes';
  return {
    schema_version: 1,
    team_id: teamId,
    status,
    merge_ready: status === 'ready_to_merge',
    execution_model: 'spec_contract_harness',
    live_subagents: {
      enabled: liveSubagentGateState.enabled,
      required_before_live_subagents: liveSubagentGateState.required_before_live_subagents,
      reason:
        'This run executed declared fixture operations from the agent team spec; it did not spawn live LLM subagents.',
    },
    summary: failed
      ? 'One or more subagents failed policy or execution checks.'
      : changedCount > 0
        ? `${agents.length} subagent(s) completed with ${changedCount} changed file(s) ready for merge review.`
        : `${agents.length} subagent(s) completed with no file changes.`,
    agents: agents.map((agent) => ({
      id: agent.agent_id,
      role: agent.role,
      status: agent.status,
      merge_strategy: agent.merge_strategy,
      changed_files: agent.changed_files.map((change) => change.path),
      evidence_path: agent.evidence_path,
    })),
    conflicts: diagnostics.filter((diagnostic) => diagnostic.severity === 'fail'),
  };
}

function readIndex(options: AgentTeamOptions = {}): AgentRunIndex {
  const indexPath = getAgentIndexPath(options);
  if (!existsSync(indexPath)) {
    return { schema_version: 1, runs: [] };
  }
  try {
    return z
      .object({
        schema_version: z.literal(1),
        runs: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            status: z.enum(['ready_to_merge', 'merged', 'failed', 'no_changes']),
            created_at: z.string(),
            run_dir: z.string(),
            project_root: z.string(),
            agent_count: z.number().int(),
          }),
        ),
      })
      .parse(JSON.parse(readFileSync(indexPath, 'utf-8')) as unknown);
  } catch {
    return { schema_version: 1, runs: [] };
  }
}

function writeIndex(index: AgentRunIndex, options: AgentTeamOptions = {}): void {
  const indexPath = getAgentIndexPath(options);
  mkdirSync(dirname(indexPath), { recursive: true });
  const tmpPath = `${indexPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, indexPath);
}

function upsertIndex(run: AgentTeamRun, options: AgentTeamOptions = {}): void {
  const index = readIndex(options);
  const summary: AgentRunSummary = {
    id: run.id,
    name: run.name,
    status: run.status,
    created_at: run.created_at,
    run_dir: run.run_dir,
    project_root: run.project_root,
    agent_count: run.agents.length,
  };
  const nextRuns = [summary, ...index.runs.filter((entry) => entry.id !== run.id)].sort(
    (left, right) => right.created_at.localeCompare(left.created_at),
  );
  writeIndex({ schema_version: 1, runs: nextRuns }, options);
}

function getRunManifestPath(runDir: string): string {
  return join(runDir, 'agent_team_run.json');
}

function getMergeReportPath(runDir: string): string {
  return join(runDir, 'merge_report.json');
}

function getMergeBackupDir(runDir: string): string {
  return join(runDir, 'pre_merge_project_files');
}

function getMergeSnapshotManifestPath(runDir: string): string {
  return join(runDir, 'pre_merge_project_files.json');
}

export function buildSubagentIsolationContract(): SubagentIsolationContract {
  return {
    schema_version: 1,
    contract_id: 'babel.subagents.isolation',
    live_subagents_enabled: true,
    required_before_live_subagents: [],
    live_execution_supported_since: '2026-06-26',
    isolation_modes: ['copy', 'git_worktree', 'none'],
    write_scope_policy: {
      declared_scope_required: true,
      overlapping_write_scopes_rejected: true,
      review_only_agents_cannot_write: true,
    },
    merge_policy: {
      evidence_required: true,
      auto_merge_requires_disjoint_scopes: true,
      rollback_path: 'pre_merge_project_files_plus_merge_report',
    },
  };
}

function writeRun(run: AgentTeamRun, options: AgentTeamOptions = {}): void {
  mkdirSync(run.run_dir, { recursive: true });
  writeFileSync(getRunManifestPath(run.run_dir), `${JSON.stringify(run, null, 2)}\n`, 'utf-8');
  writeFileSync(
    join(run.run_dir, 'lead_synthesis.json'),
    `${JSON.stringify(run.lead_synthesis, null, 2)}\n`,
    'utf-8',
  );
  upsertIndex(run, options);
}

export function parseAgentTeamSpecFile(specPath: string): AgentTeamSpec {
  const raw = JSON.parse(readFileSync(specPath, 'utf-8')) as unknown;
  return AgentTeamSpecSchema.parse(raw);
}

export function runAgentTeam(spec: AgentTeamSpec, options: AgentTeamOptions = {}): AgentTeamRun {
  const parsedSpec = AgentTeamSpecSchema.parse(spec);
  const normalizedAgents = parsedSpec.agents.map(normalizeSubagent);
  const createdAt = new Date().toISOString();
  const teamId =
    parsedSpec.id ??
    `team_${formatRunTimestamp(new Date())}_${slugify(parsedSpec.name ?? 'agent-team')}`;
  const teamName = parsedSpec.name ?? teamId;
  const projectRoot = resolve(options.projectRoot ?? parsedSpec.project_root ?? process.cwd());
  const isolation = options.isolation ?? parsedSpec.isolation;
  const runDir = join(getAgentRunsRoot(options), teamId);
  const diagnostics = [...validateDisjointWriteScopes(normalizedAgents)];

  const agents = normalizedAgents.map((agent) =>
    executeAgentOperations(teamId, agent, projectRoot, runDir, isolation),
  );
  diagnostics.push(...agents.flatMap((agent) => agent.diagnostics));

  const leadSynthesis = buildLeadSynthesis(teamId, agents, diagnostics);
  const liveSubagentGateState = getLiveSubagentGateState();
  const run: AgentTeamRun = {
    schema_version: 1,
    id: teamId,
    name: teamName,
    created_at: createdAt,
    project_root: projectRoot,
    run_dir: runDir,
    isolation,
    execution_model: 'spec_contract_harness',
    live_subagents: liveSubagentGateState,
    status: leadSynthesis.status,
    spec: parsedSpec,
    agents,
    diagnostics,
    lead_synthesis: leadSynthesis,
  };

  writeRun(run, options);
  return run;
}

export function runAgentTeamFromFile(
  specPath: string,
  options: AgentTeamOptions = {},
): AgentTeamRun {
  return runAgentTeam(parseAgentTeamSpecFile(specPath), options);
}

/**
 * Run a team of live mutation sub-agents using the AgentSession infrastructure.
 * Wire between agentTeams.ts and session.ts for live sub-agent execution.
 *
 * @param session - An AgentSession instance to execute sub-agents through
 * @param specs - Array of live sub-agent specs (id, task, writeScope)
 * @param teamName - Optional team name for the run record
 * @returns Promise resolving to the live sub-agent team result
 */
export async function runAgentTeamLive(
  session: { runLiveSubagents(specs: LiveSubagentSpec[]): Promise<any> },
  specs: LiveSubagentSpec[],
  teamName?: string,
): Promise<{
  teamId: string;
  createdAt: string;
  executionModel: 'live_subagents';
  results: any;
  live_subagents: {
    enabled: boolean;
    required_before_live_subagents: string[];
    live_execution_supported_since: string;
  };
}> {
  const contract = buildSubagentIsolationContract();
  const createdAt = new Date().toISOString();
  const teamId = `live-team_${formatRunTimestamp(new Date())}_${slugify(teamName ?? 'live-subagents')}`;

  const results = await session.runLiveSubagents(specs);

  return {
    teamId,
    createdAt,
    executionModel: 'live_subagents' as const,
    results,
    live_subagents: {
      enabled: contract.live_subagents_enabled,
      required_before_live_subagents: contract.required_before_live_subagents,
      live_execution_supported_since:
        contract.live_execution_supported_since ?? '2026-06-26',
    },
  };
}

export function listAgentRuns(options: AgentTeamOptions = {}): AgentRunIndex {
  return readIndex(options);
}

export function resolveAgentRunDir(idOrPath: string, options: AgentTeamOptions = {}): string {
  const directPath = resolve(idOrPath);
  if (existsSync(getRunManifestPath(directPath))) {
    return directPath;
  }

  const fromRoot = join(getAgentRunsRoot(options), idOrPath);
  if (existsSync(getRunManifestPath(fromRoot))) {
    return fromRoot;
  }

  const index = readIndex(options);
  const match = index.runs.find((run) => run.id === idOrPath);
  if (match) {
    return match.run_dir;
  }

  throw new Error(`Agent team run "${idOrPath}" was not found.`);
}

export function inspectAgentRun(idOrPath: string, options: AgentTeamOptions = {}): AgentTeamRun {
  const runDir = resolveAgentRunDir(idOrPath, options);
  return z
    .object({
      schema_version: z.literal(1),
    })
    .passthrough()
    .parse(
      JSON.parse(readFileSync(getRunManifestPath(runDir), 'utf-8')) as unknown,
    ) as unknown as AgentTeamRun;
}

function collectChangedFileConflicts(agents: SubagentEvidence[]): AgentDiagnostic[] {
  const owner = new Map<string, string>();
  const diagnostics: AgentDiagnostic[] = [];
  for (const agent of agents) {
    for (const change of agent.changed_files) {
      const prior = owner.get(change.path);
      if (prior && prior !== agent.agent_id) {
        diagnostics.push({
          severity: 'fail',
          code: 'changed_file_conflict',
          message: `Changed file "${change.path}" is owned by both "${prior}" and "${agent.agent_id}".`,
          agent_id: `${prior},${agent.agent_id}`,
          path: change.path,
        });
      }
      owner.set(change.path, agent.agent_id);
    }
  }
  return diagnostics;
}

function readMergeSnapshots(runDir: string): AgentMergeSnapshot[] {
  const manifestPath = getMergeSnapshotManifestPath(runDir);
  if (!existsSync(manifestPath)) {
    return [];
  }
  return z
    .array(
      z.object({
        path: z.string(),
        before_exists: z.boolean(),
        backup_path: z.string().nullable(),
        merged_exists: z.boolean(),
        merged_hash: z.string().nullable(),
      }),
    )
    .parse(JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown);
}

function writeMergeSnapshots(runDir: string, snapshots: AgentMergeSnapshot[]): void {
  const manifestPath = getMergeSnapshotManifestPath(runDir);
  mkdirSync(dirname(manifestPath), { recursive: true });
  const tmpPath = `${manifestPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(snapshots, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, manifestPath);
}

function snapshotProjectFileBeforeMerge(
  run: AgentTeamRun,
  relativePath: string,
): AgentMergeSnapshot {
  const targetPath = resolveInsideRoot(run.project_root, relativePath);
  const backupDir = getMergeBackupDir(run.run_dir);
  const backupPath = resolveInsideRoot(backupDir, relativePath);
  if (!existsSync(targetPath)) {
    return {
      path: relativePath,
      before_exists: false,
      backup_path: null,
      merged_exists: false,
      merged_hash: null,
    };
  }
  mkdirSync(dirname(backupPath), { recursive: true });
  cpSync(targetPath, backupPath, { force: true });
  return {
    path: relativePath,
    before_exists: true,
    backup_path: backupPath,
    merged_exists: false,
    merged_hash: null,
  };
}

function buildMergeRestorePlan(
  run: AgentTeamRun,
  snapshots: AgentMergeSnapshot[],
): AgentMergeRestorePlan {
  const snapshotManifestPath = getMergeSnapshotManifestPath(run.run_dir);
  return {
    available: snapshots.length > 0,
    backup_dir: getMergeBackupDir(run.run_dir),
    snapshot_manifest_path: snapshotManifestPath,
    restore_command: `babel agents restore ${run.id}`,
    inspect_command: `babel agents inspect ${run.id} --json`,
    notes:
      snapshots.length > 0
        ? [
            'Restore copies pre-merge backups back into the project root and removes files that did not exist before merge.',
            'Review the merge report before restoring when unrelated user edits may have landed after merge.',
          ]
        : ['No project files were merged, so there is nothing to restore.'],
  };
}

export function mergeAgentRun(idOrPath: string, options: AgentTeamOptions = {}): AgentMergeReport {
  const run = inspectAgentRun(idOrPath, options);
  const diagnostics: AgentDiagnostic[] = [];
  const mergedFiles: string[] = [];
  const skippedAgents: Array<{ agent_id: string; reason: string }> = [];
  const snapshots: AgentMergeSnapshot[] = [];

  if (run.status === 'failed') {
    diagnostics.push({
      severity: 'fail',
      code: 'run_failed',
      message: 'Cannot merge a failed agent team run.',
    });
  }
  diagnostics.push(...collectChangedFileConflicts(run.agents));

  if (!diagnostics.some((diagnostic) => diagnostic.severity === 'fail')) {
    for (const agent of run.agents) {
      if (agent.merge_strategy === 'review_only') {
        skippedAgents.push({ agent_id: agent.agent_id, reason: 'review_only' });
        continue;
      }
      if (agent.merge_strategy === 'manual') {
        skippedAgents.push({ agent_id: agent.agent_id, reason: 'manual_merge_required' });
        continue;
      }
      if (agent.changed_files.length === 0) {
        skippedAgents.push({ agent_id: agent.agent_id, reason: 'no_changes' });
        continue;
      }

      for (const change of agent.changed_files) {
        if (!scopeContainsPath(agent.write_scope, change.path)) {
          diagnostics.push({
            severity: 'fail',
            code: 'merge_scope_violation',
            message: `Refusing to merge "${change.path}" outside agent write scope.`,
            agent_id: agent.agent_id,
            path: change.path,
          });
          continue;
        }
        const sourcePath = resolveInsideRoot(agent.workspace_root, change.path);
        const targetPath = resolveInsideRoot(run.project_root, change.path);
        if (!existsSync(sourcePath)) {
          diagnostics.push({
            severity: 'fail',
            code: 'merge_source_missing',
            message: `Merge source file is missing: ${sourcePath}`,
            agent_id: agent.agent_id,
            path: change.path,
          });
          continue;
        }
        const snapshot = snapshotProjectFileBeforeMerge(run, change.path);
        mkdirSync(dirname(targetPath), { recursive: true });
        cpSync(sourcePath, targetPath, { force: true });
        snapshots.push({
          ...snapshot,
          merged_exists: existsSync(targetPath),
          merged_hash: readFileHash(targetPath),
        });
        mergedFiles.push(change.path);
      }
    }
  }

  const status = diagnostics.some((diagnostic) => diagnostic.severity === 'fail')
    ? 'failed'
    : skippedAgents.length > 0 && mergedFiles.length === 0
      ? 'partial'
      : 'merged';
  const report: AgentMergeReport = {
    schema_version: 1,
    team_id: run.id,
    merged_at: new Date().toISOString(),
    status,
    merged_files: mergedFiles,
    skipped_agents: skippedAgents,
    diagnostics,
    restore: buildMergeRestorePlan(run, snapshots),
  };

  writeMergeSnapshots(run.run_dir, snapshots);
  const reportPath = getMergeReportPath(run.run_dir);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  const nextRun: AgentTeamRun = {
    ...run,
    status: status === 'merged' ? 'merged' : run.status,
    merge_report_path: reportPath,
  };
  writeRun(nextRun, options);
  return report;
}

export function restoreAgentMerge(
  idOrPath: string,
  options: AgentTeamOptions = {},
): AgentMergeRestoreReport {
  const run = inspectAgentRun(idOrPath, options);
  const snapshots = readMergeSnapshots(run.run_dir);
  const diagnostics: AgentDiagnostic[] = [];
  const restoredFiles: string[] = [];
  const removedCreatedFiles: string[] = [];

  if (snapshots.length === 0) {
    diagnostics.push({
      severity: 'fail',
      code: 'merge_restore_unavailable',
      message: 'No pre-merge snapshot manifest exists for this agent-team run.',
    });
  }

  for (const snapshot of snapshots) {
    const targetPath = resolveInsideRoot(run.project_root, snapshot.path);
    if (snapshot.before_exists && (!snapshot.backup_path || !existsSync(snapshot.backup_path))) {
      diagnostics.push({
        severity: 'fail',
        code: 'merge_restore_backup_missing',
        message: `Pre-merge backup is missing for "${snapshot.path}".`,
        path: snapshot.path,
      });
      continue;
    }

    const currentExists = existsSync(targetPath);
    const currentHash = readFileHash(targetPath);
    if (currentExists !== snapshot.merged_exists || currentHash !== snapshot.merged_hash) {
      diagnostics.push({
        severity: 'fail',
        code: 'merge_restore_target_modified',
        message: `Refusing to restore "${snapshot.path}" because it changed after the agent-team merge.`,
        path: snapshot.path,
      });
    }
  }

  if (!diagnostics.some((diagnostic) => diagnostic.severity === 'fail')) {
    for (const snapshot of snapshots) {
      const targetPath = resolveInsideRoot(run.project_root, snapshot.path);
      try {
        if (snapshot.before_exists) {
          mkdirSync(dirname(targetPath), { recursive: true });
          cpSync(snapshot.backup_path!, targetPath, { force: true });
          restoredFiles.push(snapshot.path);
          continue;
        }

        if (existsSync(targetPath)) {
          rmSync(targetPath, { force: true });
          removedCreatedFiles.push(snapshot.path);
        }
      } catch (error) {
        diagnostics.push({
          severity: 'fail',
          code: 'merge_restore_failed',
          message: error instanceof Error ? error.message : String(error),
          path: snapshot.path,
        });
      }
    }
  }

  const report: AgentMergeRestoreReport = {
    schema_version: 1,
    team_id: run.id,
    restored_at: new Date().toISOString(),
    status: diagnostics.some((diagnostic) => diagnostic.severity === 'fail')
      ? 'failed'
      : 'restored',
    restored_files: restoredFiles,
    removed_created_files: removedCreatedFiles,
    diagnostics,
  };
  writeFileSync(
    join(run.run_dir, 'merge_restore_report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf-8',
  );
  return report;
}

export function createSampleAgentSpec(
  projectRoot: string = join(tmpdir(), 'babel-agent-sample'),
): AgentTeamSpec {
  return {
    schema_version: 1,
    id: 'sample-disjoint-team',
    name: 'Sample Disjoint Team',
    project_root: projectRoot,
    isolation: 'copy',
    lead_synthesis: true,
    agents: [
      {
        id: 'worker-a',
        role: 'worker',
        task: 'Write file A inside its own scope.',
        allowed_tools: ['file_read', 'file_write'],
        disallowed_tools: ['shell_exec'],
        write_scope: ['a.txt'],
        merge_strategy: 'auto_disjoint',
        operations: [
          {
            type: 'write_file',
            path: 'a.txt',
            content: 'A\n',
            rationale: 'Demonstrate disjoint worker output A.',
          },
        ],
      },
      {
        id: 'worker-b',
        role: 'worker',
        task: 'Write file B inside its own scope.',
        allowed_tools: ['file_read', 'file_write'],
        disallowed_tools: ['shell_exec'],
        write_scope: ['b.txt'],
        merge_strategy: 'auto_disjoint',
        operations: [
          {
            type: 'write_file',
            path: 'b.txt',
            content: 'B\n',
            rationale: 'Demonstrate disjoint worker output B.',
          },
        ],
      },
    ],
  };
}

export function formatAgentListHuman(index: AgentRunIndex): string {
  const lines = ['Babel Agent Team Runs', ''];
  if (index.runs.length === 0) {
    lines.push('(no agent team runs yet)');
    return lines.join('\n');
  }
  for (const run of index.runs) {
    lines.push(
      `${run.id.padEnd(36)} ${run.status.padEnd(14)} ${run.agent_count} agent(s)  ${run.name}`,
    );
  }
  return lines.join('\n');
}

export function formatAgentRunHuman(run: AgentTeamRun): string {
  const lines = [
    `Agent team: ${run.id}`,
    `Name: ${run.name}`,
    `Status: ${run.status}`,
    `Project: ${run.project_root}`,
    `Isolation: ${run.isolation}`,
    `Execution: ${run.execution_model} (live subagents: ${run.live_subagents.enabled ? 'enabled' : 'disabled'})`,
    `Run dir: ${run.run_dir}`,
    '',
    run.lead_synthesis.summary,
    '',
  ];
  for (const agent of run.agents) {
    lines.push(`${agent.agent_id}  ${agent.role}  ${agent.status}  ${agent.merge_strategy}`);
    lines.push(`  Evidence: ${agent.evidence_path}`);
    lines.push(`  Scope: ${agent.write_scope.join(', ') || '(read-only)'}`);
    lines.push(
      `  Changes: ${agent.changed_files.map((change) => change.path).join(', ') || '(none)'}`,
    );
  }
  return lines.join('\n');
}

export function formatAgentMergeHuman(report: AgentMergeReport): string {
  return [
    `Agent merge: ${report.team_id}`,
    `Status: ${report.status}`,
    `Merged files: ${report.merged_files.join(', ') || '(none)'}`,
    `Skipped agents: ${report.skipped_agents.map((agent) => `${agent.agent_id}:${agent.reason}`).join(', ') || '(none)'}`,
    `Restore: ${report.restore.available ? report.restore.restore_command : '(none)'}`,
    `Diagnostics: ${report.diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.message}`).join('; ') || '(none)'}`,
  ].join('\n');
}

export function formatAgentMergeRestoreHuman(report: AgentMergeRestoreReport): string {
  return [
    `Agent merge restore: ${report.team_id}`,
    `Status: ${report.status}`,
    `Restored files: ${report.restored_files.join(', ') || '(none)'}`,
    `Removed created files: ${report.removed_created_files.join(', ') || '(none)'}`,
    `Diagnostics: ${report.diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.message}`).join('; ') || '(none)'}`,
  ].join('\n');
}
