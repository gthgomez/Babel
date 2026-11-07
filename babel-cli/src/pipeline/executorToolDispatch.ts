import type { EvidenceBundle } from '../evidence.js';
import type { ToolCallRequest, ToolResult, ToolContext } from '../localTools.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';
import { isVerifierCommand } from '../services/terminalStatus.js';
import { canonicalizeExecutorTargetForLog, getTarget } from '../stages/executorHelpers.js';
import { BABEL_ROOT } from './paths.js';
import { createExecutorKernel, type ExecutorKernel } from '../executor/kernel.js';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertPlannerPathsAllowed, scopedHandoffPath } from '../agent/planHandoff.js';

/** Plan-bound dispatch fence: only reads and writes inside the approved scope. */
export function scopeExecutorKernel(kernel: ExecutorKernel, scope: { projectRoot: string; allowedPaths: string[] }): ExecutorKernel {
  return {
    ...kernel,
    tools: {
      async execute(req, context) {
        const denied = (): ToolResult => ({ exit_code: 126, stdout: '', stderr: '[PLAN_HANDOFF_GUARD] Tool request is outside the selected Plan scope or is not yet qualified for Plan-bound execution.' });
        if (req.tool !== 'file_read' && req.tool !== 'directory_list' && req.tool !== 'file_write') return denied();
        const path = String(req.path ?? '');
        if (assertPlannerPathsAllowed([path], scope.allowedPaths).length > 0) return denied();
        try {
          const root = realpathSync(scope.projectRoot); const physical = scopedHandoffPath(root, path);
          const expected = resolve(root, path); const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
          if (!physical || normalize(physical) !== normalize(expected)) return denied();
          if (existsSync(expected)) {
            const stat = lstatSync(expected);
            if (stat.isSymbolicLink() || stat.nlink !== 1) return denied();
            if (!stat.isFile() && !(req.tool === 'directory_list' && stat.isDirectory())) return denied();
          } else if (req.tool !== 'file_write') {
            return denied();
          }
        } catch { return denied(); }
        return kernel.tools.execute(req, context);
      },
    },
  };
}

export async function executeExecutorTool(
  req: ToolCallRequest,
  evidenceOrContext: EvidenceBundle | ToolContext,
  kernel: ExecutorKernel = createExecutorKernel('deep'),
): Promise<ToolResult> {
  const context: ToolContext = 'babelRoot' in evidenceOrContext
    ? evidenceOrContext
    : {
        agentId: 'executor',
        runId: evidenceOrContext.runId,
        runDir: evidenceOrContext.runDir,
        babelRoot: BABEL_ROOT,
      };
  return kernel.tools.execute(req, context);
}

export function buildExecutorToolCallEntry(params: {
  step: number;
  req: ToolCallRequest;
  toolResult: ToolResult;
  target?: string;
}): ToolCallLog {
  return {
    step: params.step,
    tool: params.req.tool,
    target: params.target ?? getTarget(params.req),
    exit_code: params.toolResult.exit_code,
    stdout: params.toolResult.stdout,
    stderr: params.toolResult.stderr,
    ...(params.toolResult.denial ? { denial: params.toolResult.denial } : {}),
    ...(params.toolResult.mcp_lifecycle ? { mcp_lifecycle: params.toolResult.mcp_lifecycle } : {}),
    ...(params.toolResult.checkpoint_ids
      ? { checkpoint_ids: params.toolResult.checkpoint_ids }
      : {}),
    ...(params.toolResult.directory_page ? { directory_page: params.toolResult.directory_page } : {}),
    verified: params.toolResult.exit_code === 0,
  };
}

export function buildBlockedExecutorToolCallEntry(params: {
  step: number;
  req: ToolCallRequest;
  stderr: string;
  stdout?: string;
  target?: string;
}): ToolCallLog {
  return {
    step: params.step,
    tool: params.req.tool,
    target: params.target ?? getTarget(params.req),
    exit_code: 126,
    stdout: params.stdout ?? '(blocked before execution)',
    stderr: params.stderr,
    verified: false,
  };
}

export function formatToolDenialSummary(toolResult: ToolResult): string | null {
  return toolResult.denial
    ? `${toolResult.denial.category}/${toolResult.denial.reason_code}: ${toolResult.denial.message}`
    : null;
}

export function formatMcpLifecycleSummary(toolResult: ToolResult): string | null {
  return toolResult.mcp_lifecycle
    ? `${toolResult.mcp_lifecycle.phase}/${toolResult.mcp_lifecycle.outcome}${toolResult.mcp_lifecycle.reason_code ? ` (${toolResult.mcp_lifecycle.reason_code})` : ''}`
    : null;
}

export function buildNonRecoverableToolFailureCondition(
  req: ToolCallRequest,
  toolResult: ToolResult,
): string {
  const denialSummary = formatToolDenialSummary(toolResult);
  const mcpLifecycleSummary = formatMcpLifecycleSummary(toolResult);
  return (
    `${toolResult.denial && (req.tool === 'shell_exec' || req.tool === 'test_run') ? '[SHELL_COMMAND_DENIED] ' : ''}` +
    `${!toolResult.denial && (req.tool === 'shell_exec' || req.tool === 'test_run') && isVerifierCommand(req.command) ? '[VERIFIER_FAILED] ' : ''}` +
    `${!toolResult.denial && (req.tool === 'shell_exec' || req.tool === 'test_run') && !isVerifierCommand(req.command) ? '[SHELL_COMMAND_FAILED] ' : ''}` +
    `Tool ${req.tool} on "${getTarget(req)}" exited with code ${toolResult.exit_code}. ` +
    `stderr: ${toolResult.stderr.slice(0, 200)}` +
    `${denialSummary ? ` denial: ${denialSummary}` : ''}` +
    `${mcpLifecycleSummary ? ` mcp_lifecycle: ${mcpLifecycleSummary}` : ''}`
  );
}

export function getSuccessfulFileReadCacheEntry(
  req: ToolCallRequest,
  toolResult: ToolResult,
): { key: string; stdout: string } | null {
  if (req.tool !== 'file_read' || toolResult.exit_code !== 0 || !toolResult.stdout) {
    return null;
  }

  return {
    key: canonicalizeExecutorTargetForLog(String(req.path ?? ''), req.tool),
    stdout: toolResult.stdout,
  };
}

export function buildTruncationArtifactConditions(path: string): {
  reportCondition: string;
  resultCondition: string;
} {
  return {
    reportCondition:
      `[TRUNCATION_ARTIFACT] file_write for "${path}" contains the ` +
      `"... [N chars truncated] ..." history marker in its content. ` +
      `The executor copied truncated execution history instead of the FILE_READ_CACHE. ` +
      `Re-read the file from FILE_READ_CACHE and apply only the plan-specified changes.`,
    resultCondition:
      `[TRUNCATION_ARTIFACT] file_write for "${path}" contains truncation ` +
      `marker from execution history. Use FILE_READ_CACHE instead.`,
  };
}
