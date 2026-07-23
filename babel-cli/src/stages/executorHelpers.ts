import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, promises as fsPromises } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { EvidenceBundle } from '../evidence.js';
import type { ToolCallRequest } from '../localTools.js';
import { resolveExecutionProfile } from '../config/executionProfiles.js';
import type {
  ExecutorTurnCompletion,
  HaltTag,
  SwePlan,
  ToolCallLog,
} from '../schemas/agentContracts.js';
import { ExecutorReportSchema, PipelineErrorSchema } from '../schemas/agentContracts.js';
import { FILE_READ_MAX_LENGTH, truncateLogs } from '../utils/truncate.js';
import { getManifestSnapshot, type ToolManifestSnapshot } from '../tools/toolManifest.js';
import { PRE_EXECUTION_FAILURE_CAPSULE_FILENAME } from '../services/pipelineFailureArtifacts.js';
import { maxAttemptsForRepairMode } from '../services/repairGovernance.js';
import type { AttemptSafetySummary, ProjectSafetySnapshot } from '../services/terminalStatus.js';
import type { WorktreeRollbackSummary, WorktreeSafetySummary } from '../services/worktreeSafety.js';
import type { AutonomousRepairProofTimeline } from '../services/autonomousRepairProofEvidence.js';

export function isWithinProjectRootPath(projectRoot: string, candidatePath: string): boolean {
  const root = resolve(projectRoot);
  const target = resolve(candidatePath);

  if (process.platform === 'win32') {
    const rootNorm = root.toLowerCase();
    const targetNorm = target.toLowerCase();
    return targetNorm === rootNorm || targetNorm.startsWith(`${rootNorm}\\`);
  }

  return target === root || target.startsWith(`${root}/`);
}

export function getExecutorProjectRoot(): string | null {
  const projectRoot = process.env['BABEL_PROJECT_ROOT']?.trim();
  return projectRoot && projectRoot.length > 0 ? projectRoot : null;
}

export function getTarget(req: ToolCallRequest): string {
  if (req.tool === 'directory_list' || req.tool === 'file_read' || req.tool === 'file_write') {
    return req.path;
  }
  if (req.tool === 'shell_exec' || req.tool === 'test_run') {
    return req.command;
  }
  if (req.tool === 'mcp_request') {
    return `${req.server} → ${req.query}`;
  }
  if (
    req.tool === 'mcp_resource_list' ||
    req.tool === 'mcp_prompt_list' ||
    req.tool === 'mcp_tool_search'
  ) {
    return `${req.server}${'query' in req && req.query ? ` → ${req.query}` : ''}`;
  }
  if (req.tool === 'mcp_resource_read') {
    return `${req.server} → ${req.uri}`;
  }
  if (req.tool === 'mcp_prompt_get') {
    return `${req.server} → ${req.name}`;
  }
  if (req.tool === 'web_search') {
    return req.query;
  }
  if (req.tool === 'web_fetch') {
    return req.url;
  }
  if (req.tool === 'plugin_tool') {
    return `${req.plugin} → ${req.name}`;
  }
  if (req.tool === 'audit_ui') {
    return req.url ?? JSON.stringify(req);
  }
  if (req.tool === 'memory_store' || req.tool === 'memory_query') {
    return req.key;
  }
  if (req.tool === 'tool_catalog') {
    return `category:${req.category ?? 'all'} mutating:${req.mutating ?? 'any'}`;
  }
  return JSON.stringify(req);
}

export type CommandRetryTool = 'shell_exec' | 'test_run';

export interface PendingRecoverableCommandRetry {
  readonly tool: CommandRetryTool;
  readonly command: string;
  readonly workingDirectory?: string | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly failedStep: number;
  readonly patchedTargetKeys: ReadonlySet<string>;
}

export interface RecoverableCommandRerunDecision {
  readonly force: boolean;
  readonly reason: string | null;
}

function normalizeRetryCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isSameRecoverableCommandRetry(
  req: ToolCallRequest,
  pending: PendingRecoverableCommandRetry,
): boolean {
  return (
    (req.tool === 'shell_exec' || req.tool === 'test_run') &&
    normalizeRetryCommand(req.command) === normalizeRetryCommand(pending.command)
  );
}

export function shouldForceRecoverableCommandRerun(
  pending: PendingRecoverableCommandRetry | null,
  req: ToolCallRequest,
  nextTargetKey: string | null,
): RecoverableCommandRerunDecision {
  if (!pending || pending.patchedTargetKeys.size === 0) {
    return { force: false, reason: null };
  }

  if (isSameRecoverableCommandRetry(req, pending)) {
    return { force: false, reason: null };
  }

  if (req.tool === 'file_read' || req.tool === 'directory_list') {
    return { force: false, reason: null };
  }

  if (req.tool === 'file_write' && nextTargetKey && !pending.patchedTargetKeys.has(nextTargetKey)) {
    return { force: false, reason: null };
  }

  const action =
    req.tool === 'file_write'
      ? `repeated patch write${nextTargetKey ? ` for "${nextTargetKey}"` : ''}`
      : `tool "${req.tool}"`;
  return {
    force: true,
    reason:
      `${action} attempted after recoverable command failure at step ${pending.failedStep}; ` +
      `rerun "${pending.command}" before advancing.`,
  };
}

export function canonicalizeExecutorTargetForLog(target: string, tool: string): string {
  const normalizedTarget = String(target ?? '').trim();
  if (!normalizedTarget) {
    return normalizedTarget;
  }

  if (!['directory_list', 'file_read', 'file_write'].includes(tool)) {
    return normalizedTarget;
  }

  const projectRoot = getExecutorProjectRoot();
  if (!projectRoot) {
    return normalizedTarget.replace(/\\/g, '/');
  }

  const resolvedTarget = resolveStepTargetPath(projectRoot, normalizedTarget);

  if (isWithinProjectRootPath(projectRoot, resolvedTarget)) {
    return relative(projectRoot, resolvedTarget).replace(/\\/g, '/');
  }

  return resolvedTarget;
}

export function formatExecutionResults(toolCallLog: ToolCallLog[], loopCount: number): string {
  const header = `--- GATHERED EVIDENCE (Loop ${loopCount}) ---`;
  const entries = toolCallLog.map((entry) =>
    [
      `[Step ${entry.step}] ${entry.tool} → ${canonicalizeExecutorTargetForLog(entry.target, entry.tool)}`,
      `stdout: ${entry.stdout.trim() || '(empty)'}`,
      ...(entry.stderr.trim() ? [`stderr: ${entry.stderr.trim()}`] : []),
      ...(entry.denial ? [`denial: ${JSON.stringify(entry.denial)}`] : []),
      ...(entry.mcp_lifecycle ? [`mcp_lifecycle: ${JSON.stringify(entry.mcp_lifecycle)}`] : []),
      ...(entry.checkpoint_ids && entry.checkpoint_ids.length > 0
        ? [`checkpoint_ids: ${entry.checkpoint_ids.join(', ')}`]
        : []),
    ].join('\n'),
  );
  return [header, ...entries].join('\n\n');
}

function formatDenialSummary(denial: ToolCallLog['denial']): string | null {
  if (!denial) {
    return null;
  }
  return `${denial.category}/${denial.reason_code}: ${denial.message}`;
}

function formatMcpLifecycleSummary(lifecycle: ToolCallLog['mcp_lifecycle']): string | null {
  if (!lifecycle) {
    return null;
  }
  const reason = lifecycle.reason_code ? ` (${lifecycle.reason_code})` : '';
  return `${lifecycle.phase}/${lifecycle.outcome}${reason}`;
}

export interface BuildExecutorTaskOptions {
  compactFileOnly?: boolean;
  allowCommandRecovery?: boolean;
}

/** Returns true when the task contains file-specific "do not modify/edit/write"
 *  constraints (e.g. "Do not modify src/dirty.txt") that should NOT be
 *  interpreted as a global read-only directive. */
function hasFileSpecificWriteConstraints(rawTask: string): boolean {
  const noWriteRx =
    /\b(do not|don't|must not)\s+(modify|edit|write|change)\s+["']?((?:[A-Za-z]:[\\/])?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9_-]{1,12})["']?/gi;
  const matches = rawTask.matchAll(noWriteRx);
  let count = 0;
  for (const _match of matches) {
    count++;
  }
  return count > 0;
}

function buildToolShapeLine(tool: ToolManifestSnapshot): string {
  const parts: string[] = [`"type": "tool_call"`, `"tool": "${tool.name}"`];

  for (const field of tool.input.required) {
    const placeholder =
      field.name === 'content'
        ? '<full file content>'
        : field.name === 'command'
          ? '<cmd-without-cmd-slash-c-or-cd>'
          : `<${field.name}>`;
    parts.push(`"${field.name}": "${placeholder}"`);
  }

  for (const field of tool.input.optional) {
    if (field.name === 'timeout_seconds') {
      parts.push(`"${field.name}": <int, default varies>`);
    } else if (
      field.name === 'limit' ||
      field.name === 'max_results' ||
      field.name === 'max_matches' ||
      field.name === 'schema_limit' ||
      field.name === 'max_bytes' ||
      field.name === 'max_paths' ||
      field.name === 'max_depth' ||
      field.name === 'max_files' ||
      field.name === 'max_lines' ||
      field.name === 'ttl_sec'
    ) {
      parts.push(`"${field.name}": <int>`);
    } else if (field.type === 'boolean') {
      parts.push(`"${field.name}": <true|false>`);
    } else if (field.type === 'object') {
      parts.push(`"${field.name}": {}`);
    } else {
      parts.push(`"${field.name}": "<${field.name}>"`);
    }
  }

  return `  ${tool.name}: { ${parts.join(', ')} }`;
}

function buildDynamicToolShapes(compactFileOnly: boolean): string[] {
  // Completion shapes are always included
  const completions = [
    '  Done:       { "type": "completion", "status": "EXECUTION_COMPLETE" }',
    '  Halt:       { "type": "completion", "status": "EXECUTION_HALTED",   "halt_tag": "<TAG>", "condition": "<exact condition>" }',
    '  Refused:    { "type": "completion", "status": "ACTIVATION_REFUSED", "reason": "<reason>" }',
  ];

  try {
    const snapshot = getManifestSnapshot();

    if (compactFileOnly) {
      // File-only: just the filesystem tools
      const fileTools = snapshot.filter(
        (t) => t.name === 'directory_list' || t.name === 'file_read' || t.name === 'file_write',
      );
      return [...fileTools.map(buildToolShapeLine), ...completions];
    }

    // Full mode: all tools except mode-switching and meta (tool_catalog is self-referential)
    const executorTools = snapshot.filter(
      (t) => t.category !== 'mode' && t.name !== 'tool_catalog',
    );
    return [...executorTools.map(buildToolShapeLine), ...completions];
  } catch {
    // Fallback to hardcoded shapes if manifest loading fails
    // (preserves backward compatibility during migration)
    return compactFileOnly
      ? [
          '  directory_list: { "type": "tool_call", "tool": "directory_list", "path": "<project-relative or /project/... path>" }',
          '  file_read:  { "type": "tool_call", "tool": "file_read",  "path": "<project-relative or /project/... path>" }',
          '  file_write: { "type": "tool_call", "tool": "file_write", "path": "<project-relative or /project/... path>", "content": "<full file content>" }',
          ...completions,
        ]
      : [
          '  directory_list: { "type": "tool_call", "tool": "directory_list", "path": "<project-relative or /project/... path>" }',
          '  file_read:  { "type": "tool_call", "tool": "file_read",  "path": "<project-relative or /project/... path>" }',
          '  file_write: { "type": "tool_call", "tool": "file_write", "path": "<project-relative or /project/... path>", "content": "<full file content>" }',
          '  shell_exec: { "type": "tool_call", "tool": "shell_exec", "command": "<cmd-without-cmd-slash-c-or-cd>", "working_directory": "<working_directory>", "timeout_seconds": <int, default varies> }',
          '  test_run:     { "type": "tool_call", "tool": "test_run",     "command": "<cmd-without-cmd-slash-c-or-cd>", "working_directory": "<working_directory>", "timeout_seconds": <int, default varies> }',
          '  mcp_request:  { "type": "tool_call", "tool": "mcp_request",  "server": "<server>", "query": "<query>" }',
          '  mcp_resource_list: { "type": "tool_call", "tool": "mcp_resource_list", "server": "<server>" }',
          '  mcp_resource_read: { "type": "tool_call", "tool": "mcp_resource_read", "server": "<server>", "uri": "<uri>" }',
          '  mcp_prompt_list: { "type": "tool_call", "tool": "mcp_prompt_list", "server": "<server>" }',
          '  mcp_prompt_get: { "type": "tool_call", "tool": "mcp_prompt_get", "server": "<server>", "name": "<name>", "arguments": {} }',
          '  mcp_tool_search: { "type": "tool_call", "tool": "mcp_tool_search", "server": "<server>", "query": "<query>", "limit": <int>, "schema_limit": <int> }',
          '  web_search:   { "type": "tool_call", "tool": "web_search",   "query": "<query>", "max_results": <int> }',
          '  web_fetch:    { "type": "tool_call", "tool": "web_fetch",    "url": "<url>", "max_bytes": <int> }',
          '  plugin_tool:  { "type": "tool_call", "tool": "plugin_tool",  "plugin": "<plugin>", "name": "<name>", "arguments": {} }',
          '  audit_ui:     { "type": "tool_call", "tool": "audit_ui",     "url": "<url>", "run_id": "<run_id>" }',
          '  memory_store: { "type": "tool_call", "tool": "memory_store", "key": "<key>", "value": "<value>" }',
          '  memory_query: { "type": "tool_call", "tool": "memory_query", "key": "<key>" }',
          ...completions,
        ];
  }
}

export function buildExecutorTask(
  approvedPlan: SwePlan,
  rawTask: string,
  boundedExecutorLines: string[],
  options: BuildExecutorTaskOptions = {},
): string {
  const toolShapes = buildDynamicToolShapes(options.compactFileOnly ?? false);

  return [
    'Execute the following approved SWE Plan.',
    'Respond with ONLY valid JSON wrapped in a `<|tool_start|>` and `<|tool_end|>` fence — no explanation, no prose outside the fence.',
    'Example:',
    '<|tool_start|>',
    '{',
    '  "type": "tool_call",',
    '  "thinking": "monologue",',
    '  "tool": "file_read",',
    '  "path": "src/index.ts"',
    '}',
    '<|tool_end|>',
    '',
    'ACTIVATION STATUS:',
    '- The pipeline has already verified a QA PASS verdict for this plan.',
    '- You are authorized to begin tool execution now.',
    '- Do NOT refuse activation for missing QA approval unless the prompt explicitly says QA failed.',
    '- Execute the approved target paths exactly as written in the plan. Do NOT rename outputs, relocate them, or substitute generic report filenames.',
    '- Execute every approved minimal_action_set step in order. Do NOT emit EXECUTION_COMPLETE while any approved file_write step has not successfully run.',
    '- If the next remaining approved step is file_write, emit a file_write tool call for that exact target with full content.',
    '- Every file_write content payload must be complete and non-empty. Do NOT write blank files, placeholder files, or whitespace-only content.',
    '- If a tool call fingerprint is vetoed by the operator (listed under active_denials), re-emitting the exact same tool with identical parameters is a hard policy violation. You MUST propose an alternative path or command instead of retrying the identical operation.',
    ...(hasFileSpecificWriteConstraints(rawTask)
      ? [
          '',
          'FILE-SPECIFIC CONSTRAINTS DETECTED:',
          'This task includes file-specific exclusion constraints (e.g., "Do not modify src/dirty.txt").',
          'These are restrictions on SPECIFIC files only — they do NOT make the task read-only.',
          'You ARE authorized to write to all files that are NOT explicitly listed as off-limits.',
          'Do not refuse activation or halt because of file-specific constraints. Execute normally,',
          'skipping only the files explicitly named as excluded.',
        ]
      : []),
    ...(options.allowCommandRecovery
      ? [
          '- Verifier-driven retry is enabled: if execution history shows a shell_exec/test_run step failed and the host continued, inspect stderr/stdout, patch only the planned source/helper/output artifacts needed to fix that failure, and retry the same failed command before advancing. Do not complete until the command succeeds or a non-recoverable policy denial appears.',
          '- Verifier-driven retry must not introduce new dependency-install commands such as pip install, python -m pip install, uv pip install, apt-get update/install, npm install, or conda install unless that exact command is already in the approved plan. If a verifier tool or script is missing, halt with the missing verifier instead of inventing setup work.',
        ]
      : []),
    ...(boundedExecutorLines.length > 0 ? ['', ...boundedExecutorLines] : []),
    '',
    'On each turn emit EXACTLY ONE of these JSON shapes:',
    ...toolShapes,
    '',
    'Approved SWE Plan:',
    JSON.stringify(approvedPlan, null, 2),
  ].join('\n');
}

export function formatHistoryEntry(entry: ToolCallLog): string {
  if (entry.status === 'HUMAN_REJECTED') {
    return JSON.stringify(
      {
        role: 'tool',
        status: 'HUMAN_REJECTED',
        tool: entry.tool,
        target: entry.target,
        fingerprint: entry.fingerprint ?? '',
        retry_forbidden: true,
      },
      null,
      2,
    );
  }

  const fileReadSummary =
    entry.tool === 'file_read' ? summarizeFileReadForExecutor(entry.target, entry.stdout) : null;
  const stdoutDisplay =
    entry.tool === 'file_read'
      ? (fileReadSummary ?? truncateLogs(entry.stdout, FILE_READ_MAX_LENGTH)) || '(empty)'
      : truncateLogs(entry.stdout) || '(empty)';

  // M11: Wrap the entire tool result in a structured XML tag to create a clear
  // boundary between tool output and prompt instructions. The model sees a
  // self-describing result block instead of raw text.
  const body = [
    `[Step ${entry.step}] ${entry.tool} → ${canonicalizeExecutorTargetForLog(entry.target, entry.tool)}`,
    `Exit code: ${entry.exit_code}`,
    `Stdout: ${stdoutDisplay}`,
    `Stderr: ${truncateLogs(entry.stderr) || '(empty)'}`,
    ...(entry.denial ? [`Denial: ${formatDenialSummary(entry.denial)}`] : []),
    ...(entry.mcp_lifecycle
      ? [`MCP lifecycle: ${formatMcpLifecycleSummary(entry.mcp_lifecycle)}`]
      : []),
    ...(entry.checkpoint_ids && entry.checkpoint_ids.length > 0
      ? [`Checkpoint: ${entry.checkpoint_ids.join(', ')}`]
      : []),
    `Verification: ${entry.verified ? 'PASSED' : 'FAILED'}`,
  ].join('\n');
  return `<tool-result tool="${entry.tool}" exit="${entry.exit_code}">\n${body}\n</tool-result>`;
}

/**
 * Build the executor turn prompt WITHOUT the static base context.
 * The base context is intended to be sent as the system message
 * (cached across turns via provider KV cache), not repeated in
 * every user message.
 */
export function buildExecutorTurnPrompt(
  history: string,
  stepsComplete: number,
  fileReadCache: Map<string, string> = new Map(),
): string {
  const historyBlock = history.trim() || '(No steps executed yet — this is the first turn.)';

  const nextAction =
    stepsComplete > 0
      ? `${stepsComplete} step(s) already executed (see history above). Emit your next JSON tool call (including a "thinking" block). If the latest step shows Verification: FAILED, repair the cause and retry the failed operation before advancing or completing. Only emit EXECUTION_COMPLETE if every approved step, especially every file_write step, has successfully run.`
      : 'Emit your first JSON tool call. Your JSON MUST include a "thinking" field for internal reasoning. If the activation gate fails, emit ACTIVATION_REFUSED.';

  const cacheBlock =
    fileReadCache.size > 0
      ? [
          '### FILE_READ_CACHE (verbatim for normal files, summarized for very large data files):',
          ...[...fileReadCache.entries()].map(
            ([filePath, content]) =>
              `--- FILE: ${filePath} ---\n${formatCachedFileReadForExecutor(filePath, content)}\n--- END FILE: ${filePath} ---`,
          ),
        ].join('\n')
      : '';

  return [
    '### EXECUTION HISTORY SO FAR:',
    historyBlock,
    ...(cacheBlock ? ['', cacheBlock] : []),
    '',
    '### NEXT ACTION:',
    nextAction,
  ].join('\n');
}

/**
 * Build the combined executor turn prompt (legacy format with base context included).
 * Use buildExecutorTurnPrompt + systemPrompt for KV-cache-optimized execution.
 */
export function buildExecutorTurnPromptLegacy(
  baseContext: string,
  history: string,
  stepsComplete: number,
  fileReadCache: Map<string, string> = new Map(),
): string {
  return [baseContext, '', buildExecutorTurnPrompt(history, stepsComplete, fileReadCache)].join(
    '\n',
  );
}

export function summarizeFileReadForExecutor(filePath: string, content: string): string | null {
  const normalizedPath = String(filePath ?? '')
    .replace(/\\/g, '/')
    .toLowerCase();
  const lines = String(content ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const shouldSummarizeJsonl =
    normalizedPath.endsWith('.jsonl') && (content.length > 8_000 || lines.length > 80);
  if (!shouldSummarizeJsonl) {
    return null;
  }

  const records = lines
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    })
    .filter((record): record is Record<string, unknown> => record !== null);
  if (records.length === 0) {
    return [
      '[Large JSONL file summarized for executor prompt]',
      `path: ${filePath}`,
      `bytes: ${content.length}`,
      `non_empty_lines: ${lines.length}`,
      'Unable to parse JSON objects. Write helper scripts that read this file at runtime instead of reconstructing rows from prompt text.',
    ].join('\n');
  }

  const keys = [...new Set(records.flatMap((record) => Object.keys(record)))].sort();
  const requestIds = records
    .map((record) => (typeof record['request_id'] === 'string' ? record['request_id'] : null))
    .filter((value): value is string => value !== null);
  const promptStats = numericStats(records.map((record) => Number(record['prompt_len'])));
  const genStats = numericStats(records.map((record) => Number(record['gen_len'])));
  const sampleIds = [
    ...requestIds.slice(0, 5),
    ...(requestIds.length > 10 ? ['...'] : []),
    ...requestIds.slice(-5),
  ];

  return [
    '[Large JSONL file summarized for executor prompt]',
    `path: ${filePath}`,
    `bytes: ${content.length}`,
    `records: ${records.length}`,
    `fields: ${keys.join(', ') || '(unknown)'}`,
    promptStats
      ? `prompt_len: min=${promptStats.min} p50=${promptStats.p50} p95=${promptStats.p95} max=${promptStats.max}`
      : null,
    genStats
      ? `gen_len: min=${genStats.min} p50=${genStats.p50} p95=${genStats.p95} max=${genStats.max}`
      : null,
    requestIds.length > 0 ? `sample_request_ids: ${sampleIds.join(', ')}` : null,
    'Do not reconstruct every row from this summary. Write/run helper code that reads this JSONL file at runtime and writes the requested artifacts.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function formatCachedFileReadForExecutor(filePath: string, content: string): string {
  return summarizeFileReadForExecutor(filePath, content) ?? content;
}

function numericStats(
  values: number[],
): { min: number; p50: number; p95: number; max: number } | null {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  return {
    min: sorted[0]!,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1]!,
  };
}

function percentile(sortedValues: number[], fraction: number): number {
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * fraction) - 1),
  );
  return sortedValues[index]!;
}

export function buildExecutorRepairPrompt(
  originalTurnPrompt: string,
  badToolArgs: Record<string, unknown>,
  issues: string[],
): string {
  const toolName = typeof badToolArgs['tool'] === 'string' ? badToolArgs['tool'] : 'unknown';

  return [
    originalTurnPrompt,
    '',
    '---',
    '### SCHEMA REPAIR REQUIRED',
    '',
    `Your previous tool call for \`${toolName}\` passed basic structure validation but`,
    'failed the strict per-tool field check. Validation errors:',
    ...issues.map((issue) => `  - ${issue}`),
    '',
    'Your invalid output:',
    '```json',
    JSON.stringify(badToolArgs, null, 2),
    '```',
    '',
    `Emit a corrected JSON \`ExecutorTurn\` with all required fields for \`${toolName}\` present.`,
    'Output ONLY the corrected JSON — no prose, no explanation.',
  ].join('\n');
}

function getLatestQaVerdictPath(runDir: string): string | null {
  const pattern = /^03_qa_verdict_v(\d+)\.json$/;
  const candidates = readdirSync(runDir)
    .filter((name) => pattern.test(name))
    .sort((left, right) => {
      const leftMatch = pattern.exec(left);
      const rightMatch = pattern.exec(right);
      const leftVersion = leftMatch ? Number.parseInt(leftMatch[1] ?? '0', 10) : 0;
      const rightVersion = rightMatch ? Number.parseInt(rightMatch[1] ?? '0', 10) : 0;
      return rightVersion - leftVersion;
    });

  return candidates.length > 0 ? join(runDir, candidates[0]!) : null;
}

export function assertExecutorGate(runDir: string): void {
  const qaVerdictPath = getLatestQaVerdictPath(runDir);
  if (!qaVerdictPath) {
    throw new Error(
      `Executor activation refused: no QA verdict found for run "${runDir}". Stage 4 requires an explicit PASS verdict.`,
    );
  }

  const qaVerdictRaw = JSON.parse(readFileSync(qaVerdictPath, 'utf-8')) as Record<string, unknown>;
  const verdict = String(qaVerdictRaw['verdict'] ?? '')
    .trim()
    .toUpperCase();
  if (verdict !== 'PASS') {
    throw new Error(
      `Executor activation refused: latest QA verdict is "${verdict || 'UNKNOWN'}" in "${qaVerdictPath}". Stage 4 requires PASS.`,
    );
  }
}

export function buildTerminalReport(
  signal: ExecutorTurnCompletion,
  toolCallLog: ToolCallLog[],
  evidence: EvidenceBundle,
): object {
  if (signal.status === 'PARTIAL') {
    return {
      status: 'PARTIAL',
      stage_status: 'TOOL_EXECUTION_REPAIRED',
      pipeline_completion_note: 'Deterministic repair fired — human review recommended.',
      steps_executed: toolCallLog.length,
      tool_call_log: toolCallLog,
      diff_path: join(evidence.runDir, '05_diff.patch'),
      execution_log_path: join(evidence.runDir, '04_execution_report.json'),
    };
  }

  if (signal.status === 'EXECUTION_COMPLETE') {
    return {
      status: 'EXECUTION_COMPLETE',
      stage_status: 'TOOL_EXECUTION_COMPLETE',
      pipeline_completion_note:
        'Pipeline COMPLETE is decided only after downstream pre-complete and exact-invariant guards pass.',
      steps_executed: toolCallLog.length,
      tool_call_log: toolCallLog,
      diff_path: join(evidence.runDir, '05_diff.patch'),
      execution_log_path: join(evidence.runDir, '04_execution_report.json'),
    };
  }

  if (signal.status === 'EXECUTION_HALTED') {
    return {
      status: 'EXECUTION_HALTED',
      steps_executed: toolCallLog.length,
      tool_call_log: toolCallLog,
      pipeline_error: {
        halt_tag: signal.halt_tag,
        halted_at_step: toolCallLog.length + 1,
        condition: signal.condition,
      },
    };
  }

  return {
    status: 'ACTIVATION_REFUSED',
    reason: signal.reason,
    gate: 'ACTIVATION_GATE_FAIL',
  };
}

export function buildHaltReport(
  toolCallLog: ToolCallLog[],
  haltTag: HaltTag,
  haltedAtStep: number,
  condition: string,
): object {
  const lowerCondition = condition.toLowerCase();
  const stageStatus =
    lowerCondition.includes('verifier') || lowerCondition.includes('verification')
      ? 'VERIFIER_FAILED'
      : lowerCondition.includes('repair')
        ? 'REPAIR_ATTEMPT_FAILED'
        : 'EXECUTION_ATTEMPTED';
  return {
    status: 'EXECUTION_HALTED',
    stage_status: stageStatus,
    steps_executed: toolCallLog.length,
    tool_call_log: toolCallLog,
    pipeline_error: {
      halt_tag: haltTag,
      halted_at_step: haltedAtStep,
      condition,
    },
  };
}

const RUNNER_EXHAUSTION_TOOL_ERROR_SIGNALS = [
  'rate limit',
  'rate_limit',
  'quota',
  '429',
  'too many requests',
  'model busy',
  'request timeout',
  'aggregate',
  'timeout exceeded',
] as const;

export function classifyRunnerExhaustionHaltTag(condition: string): HaltTag {
  const normalized = condition.toLowerCase();
  return RUNNER_EXHAUSTION_TOOL_ERROR_SIGNALS.some((signal) => normalized.includes(signal))
    ? 'TOOL_CALL_ERROR'
    : 'HALLUCINATED_OUTPUT';
}

export function resolveStepTargetPath(projectRoot: string, target: string): string {
  const trimmed = String(target ?? '').trim();
  const canonical = trimmed.replace(/\\/g, '/');
  const canonicalLower = canonical.toLowerCase();

  if (canonicalLower === '/project' || canonicalLower.startsWith('/project/')) {
    const rest = canonical.slice('/project'.length).replace(/^\/+/, '');
    return resolve(projectRoot, rest);
  }

  const profile = resolveExecutionProfile(process.env['BABEL_EXECUTION_PROFILE']);
  if (
    profile.name === 'benchmark_container' &&
    (canonicalLower === '/app' || canonicalLower.startsWith('/app/'))
  ) {
    const rest = canonical.slice('/app'.length).replace(/^\/+/, '');
    return resolve(projectRoot, rest);
  }

  return /^[A-Za-z]:[\\/]/.test(trimmed) || isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(projectRoot, trimmed);
}

export function collectPlannedNewFileWrites(
  swePlan: SwePlan,
  projectRoot: string,
): { newFilePaths: Set<string>; missingParentDirs: Set<string> } {
  const newFilePaths = new Set<string>();
  const missingParentDirs = new Set<string>();

  for (const step of swePlan.minimal_action_set) {
    if (step.tool !== 'file_write') {
      continue;
    }

    const target = String(step.target ?? '').trim();
    if (!target) {
      continue;
    }

    const resolvedTarget = resolveStepTargetPath(projectRoot, target);
    if (!isWithinProjectRootPath(projectRoot, resolvedTarget)) {
      continue;
    }
    if (existsSync(resolvedTarget)) {
      continue;
    }

    newFilePaths.add(resolvedTarget);
    const parentDir = dirname(resolvedTarget);
    if (!existsSync(parentDir)) {
      missingParentDirs.add(parentDir);
    }
  }

  return { newFilePaths, missingParentDirs };
}

// ─── Execution report validation ──────────────────────────────────────────────

export function writeValidatedExecutionReport(
  evidence: EvidenceBundle,
  report: unknown,
  toolCallLog: ToolCallLog[],
  warnings: string[] = [],
): void {
  const uniqueWarnings = [...new Set(warnings)];
  const checkpointIds = [...new Set(toolCallLog.flatMap((entry) => entry.checkpoint_ids ?? []))];
  const reportWithWarnings =
    typeof report === 'object' && report !== null
      ? {
          ...(report as Record<string, unknown>),
          ...(checkpointIds.length > 0 ? { checkpoint_ids: checkpointIds } : {}),
          ...(uniqueWarnings.length > 0 ? { warnings: uniqueWarnings } : {}),
        }
      : report;

  try {
    const parsed = ExecutorReportSchema.parse(reportWithWarnings);
    evidence.writeExecutionLog(parsed);
    return;
  } catch (err) {
    const schemaError = err instanceof Error ? err.message : String(err);
    const condition = `[PIPELINE_ERROR] ExecutorReportSchema validation failed: ${schemaError}`;

    const pipelineError = PipelineErrorSchema.parse({
      halt_tag: 'TOOL_CALL_ERROR',
      halted_at_step: Math.max(1, toolCallLog.length),
      condition,
      ...(toolCallLog.length > 0 ? { last_tool_output: toolCallLog[toolCallLog.length - 1] } : {}),
    });

    const fallback = ExecutorReportSchema.parse({
      status: 'EXECUTION_HALTED',
      steps_executed: toolCallLog.length,
      tool_call_log: toolCallLog,
      pipeline_error: pipelineError,
      ...(checkpointIds.length > 0 ? { checkpoint_ids: checkpointIds } : {}),
      ...(uniqueWarnings.length > 0 ? { warnings: [...uniqueWarnings, condition] } : {}),
    });

    evidence.writeExecutionLog(fallback);
  }
}

// ─── Reliability repair proof ─────────────────────────────────────────────────

export const RELIABILITY_REPAIR_PROOF_MARKER = '[BABEL_RELIABILITY_AUTONOMOUS_LIVE_FAIL_THEN_PASS]';

export function isReliabilityRepairProofEnabled(rawTask: string): boolean {
  return (
    process.env['BABEL_RELIABILITY_REPAIR_PROOF'] === 'true' &&
    rawTask.includes(RELIABILITY_REPAIR_PROOF_MARKER)
  );
}

export function getReliabilityRepairProofMaxFailures(): number {
  const configured = Number.parseInt(
    process.env['BABEL_RELIABILITY_REPAIR_PROOF_MAX_FAILURES'] ?? '',
    10,
  );
  if (!Number.isFinite(configured) || configured <= 0) {
    return maxAttemptsForRepairMode('deep');
  }
  return Math.min(configured, maxAttemptsForRepairMode('deep'));
}

// ─── File hashing ─────────────────────────────────────────────────────────────

export function hashProjectFileForEvidence(
  projectRoot: string | null | undefined,
  relativePath: string,
): string | null {
  if (!projectRoot || relativePath.trim().length === 0) {
    return null;
  }
  const resolved = resolveStepTargetPath(projectRoot, relativePath);
  if (!isWithinProjectRootPath(projectRoot, resolved) || !existsSync(resolved)) {
    return null;
  }
  try {
    return createHash('sha256').update(readFileSync(resolved)).digest('hex');
  } catch {
    return null;
  }
}

const SAFETY_SNAPSHOT_MAX_FILES = 2000;
const SAFETY_SNAPSHOT_IGNORED_DIRECTORIES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  'runs',
];

export function hashAbsoluteFileForSafety(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

export function snapshotProjectFilesForSafety(
  projectRoot: string | null | undefined,
): ProjectSafetySnapshot {
  const root = projectRoot ? resolve(projectRoot) : null;
  const snapshot: ProjectSafetySnapshot = {
    root,
    files: {},
    file_count: 0,
    truncated: false,
    ignored_directories: SAFETY_SNAPSHOT_IGNORED_DIRECTORIES,
  };
  if (!root || !existsSync(root)) {
    return snapshot;
  }

  const ignored = new Set(SAFETY_SNAPSHOT_IGNORED_DIRECTORIES);
  const visit = (dir: string): void => {
    if (snapshot.truncated) {
      return;
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (snapshot.truncated) {
        return;
      }
      const absolute = join(dir, entry);
      let stat;
      try {
        stat = statSync(absolute);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!ignored.has(entry)) {
          visit(absolute);
        }
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      const relativePath = relative(root, absolute).replace(/\\/g, '/');
      snapshot.files[relativePath] = hashAbsoluteFileForSafety(absolute) ?? 'UNREADABLE';
      snapshot.file_count += 1;
      if (snapshot.file_count >= SAFETY_SNAPSHOT_MAX_FILES) {
        snapshot.truncated = true;
        return;
      }
    }
  };

  visit(root);
  return snapshot;
}

// ─── JSON artifact I/O ────────────────────────────────────────────────────────

export function readJsonArtifact<T>(runDir: string, filename: string): T | null {
  const path = join(runDir, filename);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

// ─── Terminal context ─────────────────────────────────────────────────────────

export function collectTerminalContext(runDir: string): {
  toolCallLog: ToolCallLog[];
  condition: string | null;
  failureCapsulePath: string | null;
  repairAttemptTimelinePath: string | null;
  attemptSafetySummaryPath: string | null;
  attemptSafetySummary: AttemptSafetySummary | null;
  rollbackSummaryPath: string | null;
  rollbackSummary: WorktreeRollbackSummary | null;
  worktreeSafetySummaryPath: string | null;
  worktreeSafetySummary: WorktreeSafetySummary | null;
} {
  const report = readJsonArtifact<{
    tool_call_log?: ToolCallLog[];
    pipeline_error?: { condition?: string };
    reason?: string;
  }>(runDir, '04_execution_report.json');
  const timeline =
    readJsonArtifact<AutonomousRepairProofTimeline>(runDir, 'repair_attempt_timeline.json') ??
    readJsonArtifact<AutonomousRepairProofTimeline>(runDir, '12_repair_attempt_timeline.json');
  const attemptSafetySummary = readJsonArtifact<AttemptSafetySummary>(
    runDir,
    'attempt_safety_summary.json',
  );
  const rollbackSummary = readJsonArtifact<WorktreeRollbackSummary>(
    runDir,
    'rollback_summary.json',
  );
  const worktreeSafetySummary = readJsonArtifact<WorktreeSafetySummary>(
    runDir,
    'worktree_safety_summary.json',
  );
  const latestFailureCapsulePath =
    timeline?.attempts
      .map((attempt) => attempt.failure_capsule_path)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .at(-1) ??
    (existsSync(join(runDir, PRE_EXECUTION_FAILURE_CAPSULE_FILENAME))
      ? join(runDir, PRE_EXECUTION_FAILURE_CAPSULE_FILENAME)
      : null);

  return {
    toolCallLog: report?.tool_call_log ?? [],
    condition: report?.pipeline_error?.condition ?? report?.reason ?? null,
    failureCapsulePath: latestFailureCapsulePath,
    repairAttemptTimelinePath: timeline ? join(runDir, 'repair_attempt_timeline.json') : null,
    attemptSafetySummaryPath: attemptSafetySummary
      ? join(runDir, 'attempt_safety_summary.json')
      : null,
    attemptSafetySummary,
    rollbackSummaryPath: rollbackSummary ? join(runDir, 'rollback_summary.json') : null,
    rollbackSummary,
    worktreeSafetySummaryPath: worktreeSafetySummary
      ? join(runDir, 'worktree_safety_summary.json')
      : null,
    worktreeSafetySummary,
  };
}

// ─── Verifier stream ──────────────────────────────────────────────────────────

export function summarizeVerifierStreamForEvidence(text: string | null | undefined): string | null {
  const normalized = String(text ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-12)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized.slice(0, 700) : null;
}

// ─── Session state ────────────────────────────────────────────────────────────

export async function saveSessionState(
  runDir: string,
  deniedFingerprints: Map<string, { count: number; turn: number }>,
) {
  const sessionStatePath = join(runDir, 'session_state.json');
  const tempPath = sessionStatePath + '.tmp';
  const data = {
    deniedFingerprints: Array.from(deniedFingerprints.entries()).map(([fp, val]) => ({
      fingerprint: fp,
      count: val.count,
      turn: val.turn,
    })),
  };
  try {
    await fsPromises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await fsPromises.rename(tempPath, sessionStatePath);
  } catch (err) {
    // ignore
  }
}
