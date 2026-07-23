import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OutputBuffer } from './outputBuffer.js';
import type { LiteFullRouteDecision } from '../services/liteFullRouter.js';
import type { WorkerChainManifest } from '../services/liteRecovery.js';

export interface LiteSessionLoopStepView {
  phase: string;
  status: string;
  policy_decision?: string;
}

export interface LiteToolCallView {
  step: number;
  tool: string;
  target: string;
  exit_code: number;
}

export interface LiteSessionActivity {
  sessionLoopSteps: LiteSessionLoopStepView[];
  toolCallLog: LiteToolCallView[];
}

function readJsonRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseSessionLoopSteps(raw: unknown): LiteSessionLoopStepView[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const phase = typeof record['phase'] === 'string' ? record['phase'] : null;
    const status = typeof record['status'] === 'string' ? record['status'] : null;
    if (!phase || !status) {
      return [];
    }
    const policy =
      typeof record['policy_decision'] === 'string' ? record['policy_decision'] : undefined;
    return [
      {
        phase,
        status,
        ...(policy !== undefined ? { policy_decision: policy } : {}),
      },
    ];
  });
}

function parseToolCallLog(raw: unknown): LiteToolCallView[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const tool = typeof record['tool'] === 'string' ? record['tool'] : null;
    const target = typeof record['target'] === 'string' ? record['target'] : null;
    if (!tool || !target) {
      return [];
    }
    const step = typeof record['step'] === 'number' ? record['step'] : index + 1;
    const exitCode = typeof record['exit_code'] === 'number' ? record['exit_code'] : 0;
    return [{ step, tool, target, exit_code: exitCode }];
  });
}

function loadToolCallLogFromRunDir(runDir: string): LiteToolCallView[] {
  const executionReport = readJsonRecord(join(runDir, '04_execution_report.json'));
  const fromExecution = parseToolCallLog(executionReport?.['tool_call_log']);
  if (fromExecution.length > 0) {
    return fromExecution;
  }

  if (!existsSync(runDir)) {
    return [];
  }
  for (const entry of readdirSync(runDir)) {
    if (!entry.endsWith('_session_loop.json')) {
      continue;
    }
    const loopFile = readJsonRecord(join(runDir, entry));
    const fromLoop = parseToolCallLog(loopFile?.['tool_call_log']);
    if (fromLoop.length > 0) {
      return fromLoop;
    }
  }
  return [];
}

export function extractLiteSessionActivity(
  payload: Record<string, unknown>,
  runDir: string | null,
): LiteSessionActivity {
  const sessionLoopSteps = parseSessionLoopSteps(payload['session_loop_steps']);
  const toolCallLog = runDir ? loadToolCallLogFromRunDir(runDir) : [];
  return { sessionLoopSteps, toolCallLog };
}

export function formatSessionLoopStepLine(step: LiteSessionLoopStepView): string {
  const base = `${step.phase} ${step.status}`;
  if (step.status === 'blocked' && step.policy_decision) {
    return `${base} (${step.policy_decision})`;
  }
  return base;
}

export function formatToolCallLine(tool: LiteToolCallView, maxTargetLength = 72): string {
  const target =
    tool.target.length > maxTargetLength
      ? `${tool.target.slice(0, maxTargetLength - 1)}…`
      : tool.target;
  const outcome = tool.exit_code === 0 ? 'ok' : `exit ${tool.exit_code}`;
  return `${tool.tool} ${target} → ${outcome}`;
}

export function formatLiteRouteSummary(
  payload: Record<string, unknown>,
  routeDecision?: LiteFullRouteDecision,
): string {
  const lane =
    typeof payload['selected_lane'] === 'string'
      ? payload['selected_lane']
      : routeDecision?.selected_lane;
  const executionPath =
    typeof payload['execution_path'] === 'string' ? payload['execution_path'] : null;
  const parts: string[] = [];
  if (lane) {
    parts.push(`lane=${lane}`);
  }
  if (executionPath) {
    parts.push(`execution_path=${executionPath}`);
  }
  return parts.length > 0 ? parts.join(' | ') : '';
}

export function formatLiteSessionActivityHuman(activity: LiteSessionActivity): string {
  const lines: string[] = [];
  if (activity.sessionLoopSteps.length > 0) {
    lines.push('Session loop:');
    for (const step of activity.sessionLoopSteps) {
      lines.push(`  ${formatSessionLoopStepLine(step)}`);
    }
  }
  if (activity.toolCallLog.length > 0) {
    lines.push('Tools:');
    for (const tool of activity.toolCallLog) {
      lines.push(`  ${formatToolCallLine(tool)}`);
    }
  }
  return lines.join('\n');
}

export function formatWorkerChainStatusHuman(manifest: WorkerChainManifest): string {
  const lines = [
    'Babel Lite Worker Chain',
    `Session: ${manifest.session_run_dir}`,
    `Task: ${manifest.task}`,
    `Status: ${manifest.chain_status}`,
  ];
  if (manifest.next_verb) {
    lines.push(`Next verb: ${manifest.next_verb}`);
  }
  if (manifest.failed_step) {
    lines.push(`Failed step: ${manifest.failed_step}`);
  }
  if (manifest.steps.length > 0) {
    lines.push('Steps:');
    for (const step of manifest.steps) {
      const runDir = step.run_dir ? ` @ ${step.run_dir}` : '';
      lines.push(`  ${step.verb} ${step.status} (exit ${step.exit_code})${runDir}`);
    }
  }
  lines.push(`Updated: ${manifest.updated_at}`);
  return lines.join('\n');
}

export function shouldPrintLiteSessionActivity(activity: LiteSessionActivity): boolean {
  return activity.sessionLoopSteps.length > 0 || activity.toolCallLog.length > 0;
}

export function printLiteSessionActivity(
  payload: Record<string, unknown>,
  runDir: string | null,
  writeLine: (line: string) => void = (line) => OutputBuffer.getInstance().write(`${line}\n`),
): void {
  const activity = extractLiteSessionActivity(payload, runDir);
  if (!shouldPrintLiteSessionActivity(activity)) {
    return;
  }
  const human = formatLiteSessionActivityHuman(activity);
  if (human) {
    writeLine('');
    writeLine(human);
  }
}
