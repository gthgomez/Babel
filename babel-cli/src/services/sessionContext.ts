import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EvidenceBundle } from '../evidence.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';

export type ExecutorSessionContextStatus =
  | 'ready_for_next_turn'
  | 'after_tool_call'
  | 'terminal';

export interface ExecutorSessionContextSnapshot {
  schema_version: 1;
  kind: 'executor_model_context';
  run_id: string;
  run_dir: string;
  updated_at: string;
  stage: 'executor';
  status: ExecutorSessionContextStatus;
  terminal_status?: string;
  halt_tag?: string;
  condition?: string;
  steps_complete: number;
  context_fingerprint: string;
  approval_state: {
    executor_gate: 'PASS' | 'BLOCKED';
    qa_verdict: string | null;
    qa_verdict_path: string | null;
  };
  model_context: {
    base_context: string;
    execution_history: string;
    next_turn_prompt: string;
    file_read_cache: Array<{
      path: string;
      content: string;
    }>;
    tool_call_log: ToolCallLog[];
  };
  restore: {
    command: string;
    note: string;
  };
}

export function getSessionContextPath(runDir: string): string {
  return join(runDir, '10_session_context.json');
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function findLatestQaVerdict(runDir: string): { verdict: string | null; path: string | null } {
  if (!existsSync(runDir)) {
    return { verdict: null, path: null };
  }

  const pattern = /^03_qa_verdict_v(\d+)\.json$/;
  const candidates = readdirSync(runDir)
    .filter((name) => pattern.test(name))
    .sort((left, right) => {
      const leftVersion = Number.parseInt(pattern.exec(left)?.[1] ?? '0', 10);
      const rightVersion = Number.parseInt(pattern.exec(right)?.[1] ?? '0', 10);
      return rightVersion - leftVersion;
    });

  for (const candidate of candidates) {
    const path = join(runDir, candidate);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      return {
        verdict: typeof parsed['verdict'] === 'string' ? parsed['verdict'] : null,
        path,
      };
    } catch {
      continue;
    }
  }

  return { verdict: null, path: null };
}

export function writeExecutorSessionContext(options: {
  evidence: EvidenceBundle;
  status: ExecutorSessionContextStatus;
  baseContext: string;
  executionHistory: string;
  nextTurnPrompt: string;
  fileReadCache: Map<string, string>;
  toolCallLog: ToolCallLog[];
  terminalStatus?: string;
  haltTag?: string;
  condition?: string;
}): ExecutorSessionContextSnapshot {
  const qa = findLatestQaVerdict(options.evidence.runDir);
  const snapshot: ExecutorSessionContextSnapshot = {
    schema_version: 1,
    kind: 'executor_model_context',
    run_id: options.evidence.runId,
    run_dir: options.evidence.runDir,
    updated_at: new Date().toISOString(),
    stage: 'executor',
    status: options.status,
    ...(options.terminalStatus ? { terminal_status: options.terminalStatus } : {}),
    ...(options.haltTag ? { halt_tag: options.haltTag } : {}),
    ...(options.condition ? { condition: options.condition } : {}),
    steps_complete: options.toolCallLog.length,
    context_fingerprint: hashText(options.nextTurnPrompt),
    approval_state: {
      executor_gate: qa.verdict === 'PASS' ? 'PASS' : 'BLOCKED',
      qa_verdict: qa.verdict,
      qa_verdict_path: qa.path,
    },
    model_context: {
      base_context: options.baseContext,
      execution_history: options.executionHistory,
      next_turn_prompt: options.nextTurnPrompt,
      file_read_cache: [...options.fileReadCache.entries()].map(([path, content]) => ({ path, content })),
      tool_call_log: options.toolCallLog,
    },
    restore: {
      command: `babel session resume "${options.evidence.runDir}" --json`,
      note: 'This artifact preserves the stateless executor prompt, execution history, file-read cache, tool log, and QA approval state needed to continue model execution.',
    },
  };

  writeFileSync(getSessionContextPath(options.evidence.runDir), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
  return snapshot;
}

export function readExecutorSessionContext(runDir: string): ExecutorSessionContextSnapshot | null {
  const path = getSessionContextPath(runDir);
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as ExecutorSessionContextSnapshot;
}

export function summarizeExecutorSessionContext(snapshot: ExecutorSessionContextSnapshot | null): {
  available: boolean;
  path: string | null;
  updated_at: string | null;
  status: string | null;
  steps_complete: number;
  context_fingerprint: string | null;
  approval_state: ExecutorSessionContextSnapshot['approval_state'] | null;
} {
  if (!snapshot) {
    return {
      available: false,
      path: null,
      updated_at: null,
      status: null,
      steps_complete: 0,
      context_fingerprint: null,
      approval_state: null,
    };
  }

  return {
    available: true,
    path: getSessionContextPath(snapshot.run_dir),
    updated_at: snapshot.updated_at,
    status: snapshot.status,
    steps_complete: snapshot.steps_complete,
    context_fingerprint: snapshot.context_fingerprint,
    approval_state: snapshot.approval_state,
  };
}
