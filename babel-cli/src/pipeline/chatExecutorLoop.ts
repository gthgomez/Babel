/**
 * chatExecutorLoop.ts — Simplified executor for chat mode
 *
 * Chat mode executes plans through the sandbox without QA reviewer,
 * repair governance, evidence loops, or autonomous repair proof.
 * Single-pass: iterate action steps → execute through sandbox → return.
 *
 * Security: all tool calls go through `executeTool` (sandbox-gated).
 * Policy decisions (deny/ask) are enforced by the sandbox, not re-checked here.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolCallLog, SwePlan, ActionStep } from '../schemas/agentContracts.js';
import type { ToolCallRequest, ToolContext, ToolResult } from '../localTools.js';
import { executeExecutorTool } from './executorToolDispatch.js';
import { EvidenceBundle } from '../evidence.js';
import { BABEL_ROOT } from '../cli/constants.js';
import { writeValidatedExecutionReport } from './executionReports.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChatExecutorResult {
  terminalStatus: 'EXECUTION_COMPLETE' | 'EXECUTOR_HALTED';
  toolCallLog: ToolCallLog[];
  haltReason?: string;
  changedFiles: string[];
}

// ─── Action step → tool call mapping ───────────────────────────────────────

function mapStepToRequest(step: ActionStep): ToolCallRequest | null {
  switch (step.tool) {
    case 'file_read':
      return { tool: 'file_read', path: step.target };
    case 'directory_list':
      return { tool: 'directory_list', path: step.target };
    case 'grep':
      return { tool: 'grep', pattern: step.target };
    case 'glob':
      return { tool: 'glob', pattern: step.target };
    case 'shell_exec':
    case 'test_run':
      return { tool: 'shell_exec', command: step.target };
    case 'file_write':
      return {
        tool: 'file_write',
        path: step.target,
        content: step.content ?? '',
      };
    default:
      // mcp_request, web_search, web_fetch, etc. — not supported in chat executor
      return null;
  }
}

function isMutatingTool(tool: string): boolean {
  return tool === 'file_write' || tool === 'shell_exec' || tool === 'test_run';
}

// ─── Main loop ─────────────────────────────────────────────────────────────

export async function runChatExecutorLoop(
  approvedPlan: SwePlan,
  evidence: EvidenceBundle,
  rawTask: string,
  toolContext: Pick<ToolContext, 'signal' | 'projectRoot'> = {},
): Promise<ChatExecutorResult> {
  const toolCallLog: ToolCallLog[] = [];
  const changedFiles: string[] = [];
  const steps = approvedPlan.minimal_action_set;

  const finish = (haltReason?: string, haltedAtStep = 1): ChatExecutorResult => {
    const halted = haltReason !== undefined;
    writeValidatedExecutionReport(evidence, halted ? {
      status: 'EXECUTION_HALTED',
      steps_executed: toolCallLog.length,
      tool_call_log: toolCallLog,
      pipeline_error: {
        halt_tag: 'STEP_VERIFICATION_FAIL',
        halted_at_step: haltedAtStep,
        condition: haltReason,
      },
    } : {
      status: 'EXECUTION_COMPLETE',
      stage_status: 'TOOL_EXECUTION_COMPLETE',
      pipeline_completion_note: 'Tool execution finished; pipeline completion depends on downstream verification.',
      steps_executed: toolCallLog.length,
      tool_call_log: toolCallLog,
      diff_path: join(evidence.runDir, '05_diff.patch'),
      execution_log_path: join(evidence.runDir, '04_execution_report.json'),
    }, toolCallLog);
    return {
      terminalStatus: halted ? 'EXECUTOR_HALTED' : 'EXECUTION_COMPLETE',
      toolCallLog,
      changedFiles,
      ...(halted ? { haltReason } : {}),
    };
  };

  for (const step of steps) {
    if (toolContext.signal?.aborted) {
      return finish('Chat execution cancelled before the next step.', step.step);
    }
    if (step.tool === 'file_write' && typeof step.content !== 'string') {
      return finish(`Step ${step.step} (file_write ${step.target}) has no content; the file was not written.`, step.step);
    }
    const request = mapStepToRequest(step);

    if (request === null) {
      return finish(`Step ${step.step} (${step.tool} ${step.target}) is not supported by the Chat executor.`, step.step);
    }

    let result: ToolResult;
    try {
      result = await executeExecutorTool(request, {
        agentId: 'chat-executor',
        runId: evidence.runId,
        runDir: evidence.runDir,
        babelRoot: BABEL_ROOT,
        ...toolContext,
      });
    } catch (error) {
      result = {
        exit_code: toolContext.signal?.aborted ? 130 : 1,
        stdout: '',
        stderr: toolContext.signal?.aborted ? 'Chat execution cancelled during the tool call.' : error instanceof Error ? error.message : String(error),
      };
    }

    const entry: ToolCallLog = {
      step: step.step,
      tool: request.tool,
      target:
        request.tool === 'shell_exec' || request.tool === 'test_run'
          ? (request as { command: string }).command
          : ((request as { path: string }).path ?? step.target),
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      verified: result.exit_code === 0,
      ...(result.denial ? { denial: result.denial } : {}),
    };
    toolCallLog.push(entry);

    if (isMutatingTool(request.tool) && result.exit_code === 0) {
      const targetPath = (request as { path?: string }).path;
      if (targetPath) changedFiles.push(targetPath);
    }

    // Halt on failure
    if (result.exit_code !== 0 && !result.denial) {
      return finish(`Step ${step.step} (${step.tool} ${step.target}) failed with exit code ${result.exit_code}: ${result.stderr || result.stdout || 'unknown error'}`, step.step);
    }

    // Denied tools halt
    if (result.denial) {
      return finish(`Step ${step.step} (${step.tool} ${step.target}) was denied: ${result.denial.message ?? result.denial.reason_code}`, step.step);
    }
  }

  return toolContext.signal?.aborted ? finish('Chat execution cancelled.') : finish();
}

// ─── Display formatting (rich annotations for TUI) ──────────────────────────

/**
 * Format a completed tool call for user-facing display.
 * Produces rich annotations like Claude Code: file sizes, line counts, durations.
 */
export function formatToolCallForDisplay(entry: ToolCallLog, projectRoot: string): string | null {
  const { tool, target, exit_code, stdout, stderr } = entry;

  if (exit_code !== 0 || entry.denial) {
    return `${tool} ${target} (${entry.denial ? 'denied' : `failed, exit ${exit_code}`})`;
  }

  switch (tool) {
    case 'file_read': {
      const size = getFileSize(target, projectRoot);
      return size ? `Read ${target} (${size})` : `Read ${target}`;
    }
    case 'file_write': {
      const diff = extractDiffSummary(stdout);
      return diff ? `Wrote ${target} (${diff})` : `Wrote ${target}`;
    }
    case 'shell_exec':
    case 'test_run': {
      if (exit_code === 0) {
        const duration = extractDuration(stdout);
        return duration ? `Ran ${target} (passed in ${duration})` : `Ran ${target} (passed)`;
      }
      return `Ran ${target} (exit ${exit_code})`;
    }
    case 'grep': {
      const count = countMatches(stdout);
      return count > 0
        ? `Searched for "${target}" (${count} match${count === 1 ? '' : 'es'})`
        : `Searched for "${target}" (no matches)`;
    }
    case 'glob': {
      const count = countMatches(stdout);
      return count > 0
        ? `Found ${count} file${count === 1 ? '' : 's'} matching "${target}"`
        : `No files match "${target}"`;
    }
    case 'directory_list': {
      const count = countMatches(stdout);
      return count > 0
        ? `Listed ${target} (${count} entr${count === 1 ? 'y' : 'ies'})`
        : `Listed ${target} (empty)`;
    }
    default:
      return null;
  }
}

function getFileSize(filePath: string, projectRoot: string): string | null {
  try {
    const absPath = join(projectRoot, filePath);
    if (!existsSync(absPath)) return null;
    const stats = statSync(absPath);
    const bytes = stats.size;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } catch {
    return null;
  }
}

function extractDiffSummary(stdout: string): string | null {
  const added = (stdout.match(/^\+/gm) || []).length;
  const removed = (stdout.match(/^-/gm) || []).length;
  if (added === 0 && removed === 0) return null;
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`-${removed}`);
  return parts.join(' / ');
}

function extractDuration(stdout: string): string | null {
  const match = stdout.match(/(?:in|took)\s+(\d+\.?\d*\s*(?:s|ms|sec|seconds))/i);
  return match?.[1] ?? null;
}

function countMatches(stdout: string): number {
  return stdout.split('\n').filter((line) => line.trim().length > 0).length;
}
