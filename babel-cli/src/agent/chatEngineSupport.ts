/**
 * Session helpers extracted from ChatEngine (architectural file-size ratchet).
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { BlockedReport } from '../schemas/agentContracts.js';
import type { ToolCallRequest, ToolContext, ToolResult } from '../localTools.js';
import {
  formatChatToolObservation,
  mapChatLspActionToToolRequest,
  type ChatMessage,
  type ChatToolAction,
} from './chatToolDefinitions.js';
import { isSuccessfulDirectMutation } from './mutationTools.js';

/**
 * Pin BABEL_PROJECT_ROOT for the duration of a tool action (P2.4).
 * SafeExecutor / localTools resolve paths via BABEL_PROJECT_ROOT || cwd.
 */
export function pinProjectRootEnv(projectRoot: string): () => void {
  const previous = process.env['BABEL_PROJECT_ROOT'];
  process.env['BABEL_PROJECT_ROOT'] = projectRoot;
  return () => {
    if (previous === undefined) {
      delete process.env['BABEL_PROJECT_ROOT'];
    } else {
      process.env['BABEL_PROJECT_ROOT'] = previous;
    }
  };
}

/** Map a native tool-use event into a ChatToolAction for policy-gated execution. */
export function nativeToolUseToChatAction(
  name: string,
  input: Record<string, unknown>,
): ChatToolAction {
  if (name === 'finish') {
    return { type: 'finish' };
  }
  return { type: name as ChatToolAction['type'], ...input } as ChatToolAction;
}

/**
 * Execute an LSP chat action via localTools and return log + observation payload.
 * Extracted from ChatEngine to keep the file-size ratchet from growing.
 */
export async function executeLspChatToolAction(args: {
  action: Extract<ChatToolAction, { type: 'lsp' }>;
  toolContext: ToolContext;
  executeTool: (req: ToolCallRequest, ctx: ToolContext) => Promise<ToolResult>;
}): Promise<{
  detail: string;
  exit_code: number | undefined;
  stdout: string | undefined;
  stderr: string | undefined;
  failed: boolean;
  observation: string;
}> {
  const lspResult = await args.executeTool(
    mapChatLspActionToToolRequest(args.action),
    args.toolContext,
  );
  const detail =
    lspResult.exit_code === 0
      ? formatResultDetail(args.action, lspResult)
      : `exit ${lspResult.exit_code ?? -1}`;
  return {
    detail,
    exit_code: lspResult.exit_code,
    stdout: lspResult.stdout,
    stderr: lspResult.stderr,
    failed: lspResult.exit_code !== 0,
    observation: formatChatToolObservation(args.action, {
      stdout: lspResult.stdout,
      stderr: lspResult.stderr,
      exitCode: lspResult.exit_code,
    }),
  };
}

/** Compact one-line detail for tool result logging / UI. */
export function formatResultDetail(
  action: ChatToolAction,
  result: { stdout?: string; stderr?: string; exit_code?: number },
): string {
  const stdout = result.stdout ?? '';
  switch (action.type) {
    case 'read_file':
      return `${stdout.length} B`;
    case 'list_dir':
      return `${stdout.split('\n').filter(Boolean).length} entries`;
    case 'grep':
    case 'glob':
      return `${stdout.split('\n').filter(Boolean).length} matches`;
    case 'run_command':
    case 'await_command':
    case 'test_run':
      return `exit ${result.exit_code ?? -1}`;
    case 'write_file':
      return `${stdout.length} B written`;
    case 'apply_patch':
      return 'applied';
    case 'semantic_search':
      return `${stdout.split('\n').filter(Boolean).length} hits`;
    case 'git_context':
      return action.format ?? 'summary';
    case 'mcp_tool_search':
    case 'mcp_request':
      return result.exit_code === 0 ? 'ok' : `exit ${result.exit_code ?? -1}`;
    case 'web_search': {
      if (result.exit_code !== 0) return `exit ${result.exit_code ?? -1}`;
      try {
        const payload = JSON.parse(stdout) as { results?: unknown[] } | null;
        if (payload === null || typeof payload !== 'object') {
          return `${stdout.length} B`;
        }
        const n = Array.isArray(payload.results) ? payload.results.length : 0;
        return `${n} results`;
      } catch {
        return `${stdout.length} B`;
      }
    }
    case 'web_fetch':
      return result.exit_code === 0 ? `${stdout.length} B` : `exit ${result.exit_code ?? -1}`;
    case 'lsp': {
      if (result.exit_code !== 0) return `exit ${result.exit_code ?? -1}`;
      try {
        const payload = JSON.parse(stdout) as { resultCount?: number; operation?: string } | null;
        if (payload && typeof payload.resultCount === 'number') {
          return `${payload.operation ?? 'lsp'}: ${payload.resultCount}`;
        }
      } catch {
        // fall through
      }
      return `${stdout.length} B`;
    }
    default:
      return 'done';
  }
}

export function countPatchStats(patch: string): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) adds++;
    if (line.startsWith('-') && !line.startsWith('---')) dels++;
  }
  return { adds, dels };
}

export function primaryPatchPath(patch: string): string {
  const match = patch.match(/^\+\+\+ [ab]?\/?(.+)/m);
  return match?.[1]?.trim() ?? 'patch';
}

/**
 * R3a: Fast post-edit static check (tsc / node --check / py_compile).
 * Returns null when no checker applies. Never throws.
 */
export async function runPostEditStaticCheck(
  filePath: string,
  projectRoot: string,
): Promise<string | null> {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return null;

  try {
    const tscTimeout = 5_000;
    const fastCheckTimeout = 2_000;

    if (ext === 'ts' || ext === 'tsx') {
      if (existsSync(join(projectRoot, 'node_modules', 'typescript'))) {
        try {
          const out = execFileSync(
            'npx',
            ['tsc', '--noEmit', '--pretty', 'false', filePath],
            {
              cwd: projectRoot,
              timeout: tscTimeout,
              encoding: 'utf-8',
              maxBuffer: 1024 * 64,
            },
          );
          return `exit_code: 0\n${out}`;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return `exit_code: 1\n${msg}`;
        }
      }
      return null;
    }

    if (ext === 'js') {
      try {
        const out = execFileSync('node', ['--check', filePath], {
          cwd: projectRoot,
          timeout: fastCheckTimeout,
          encoding: 'utf-8',
          maxBuffer: 1024 * 32,
        });
        return `exit_code: 0\n${out}`;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `exit_code: 1\n${msg}`;
      }
    }

    if (ext === 'py') {
      try {
        const out = execFileSync('python', ['-m', 'py_compile', filePath], {
          cwd: projectRoot,
          timeout: fastCheckTimeout,
          encoding: 'utf-8',
          maxBuffer: 1024 * 32,
        });
        return `exit_code: 0\n${out}`;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `exit_code: 1\n${msg}`;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Lightweight text summary of dropped conversation turns (no LLM). */
export function summarizeDroppedTurns(dropped: ChatMessage[]): string {
  const facts: string[] = [];
  for (const m of dropped) {
    if (m.role === 'tool' && m.content) {
      const firstLine = m.content.split('\n')[0]?.trim();
      if (firstLine && firstLine.length > 10 && firstLine.length < 200) {
        facts.push(`- ${firstLine}`);
      }
    } else if (m.role === 'user' && m.content) {
      facts.push(`- User asked: "${m.content.slice(0, 120)}"`);
    }
  }
  if (facts.length > 0) {
    return `[Compacted ${dropped.length} messages. Key context:\n${facts.slice(0, 8).join('\n')}]`;
  }
  return `[${dropped.length} earlier messages compacted for length]`;
}

export type BlockedToolLogEntry = {
  tool: string;
  target: string;
  stdout?: string;
  stderr?: string;
};

/**
 * R1: Detect BLOCKED in model answer and build a structured report from the
 * tool log. Returns null when keyword missing or no investigate evidence.
 */
export function detectAndBuildBlockedReport(
  answer: string,
  toolCallLog: BlockedToolLogEntry[],
): BlockedReport | null {
  if (!/\bBLOCKED\b/.test(answer)) return null;

  const reasonMatch = answer.match(/\bBLOCKED\b[:\s]+(.+?)(?:\.\s|\n|$)/);
  const reason = reasonMatch?.[1]?.trim() || 'Task is blocked and cannot be completed.';

  const missingMatch = answer.match(
    /\b(missing|absent|unavailable|doesn'?t\s+exist|not\s+found)\b[:\s]+(.+?)(?:\.\s|\n|$)/i,
  );
  const missing = missingMatch?.[2]?.trim() || reason;

  const investigateTools = new Set([
    'read_file',
    'read_range',
    'grep',
    'glob',
    'list_dir',
    'run_command',
    'shell_exec',
    'test_run',
  ]);
  const checked = toolCallLog
    .filter((tc): tc is typeof tc & { target: string } => {
      try {
        return investigateTools.has(tc.tool) && !!tc.target;
      } catch {
        return false;
      }
    })
    .slice(-15)
    .map((tc) => ({
      action: tc.tool,
      target: tc.target!,
      finding: tc.stdout
        ? tc.stdout.length > 200
          ? tc.stdout.slice(0, 200) + '…'
          : tc.stdout
        : tc.stderr
          ? `Error: ${tc.stderr.slice(0, 200)}`
          : 'Investigated — see tool call log for details.',
    }));

  if (checked.length === 0) return null;

  return {
    schema_version: 1,
    status: 'BLOCKED' as const,
    reason,
    missing,
    checked,
    next_steps: [
      'Review the blocked report and provide the missing dependencies before retrying.',
    ],
  };
}

export type CompactConversationState = {
  conversation: ChatMessage[];
  toolCallLog: Array<{ tool: string; error?: string }>;
  lastVerifierReceipt: { command: string; exit_code: number } | null;
  todosSize: number;
  lastPhase: string | null;
  apiTokenCount: number;
  maxConversationMessages: number;
  maxEstimatedTokens: number;
  compactionConsecutiveFailures: number;
  maxCompactionFailures: number;
  summarizeDroppedTurns: (dropped: ChatMessage[]) => string;
};

/** Heuristic conversation compaction. Mutates state fields in place. */
export function compactHeuristicConversation(state: CompactConversationState): void {
  if (state.conversation.length <= state.maxConversationMessages) {
    const totalChars = state.conversation.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens =
      state.apiTokenCount > 0 ? state.apiTokenCount : Math.ceil(totalChars / 3);
    if (estimatedTokens <= state.maxEstimatedTokens) return;
  }

  if (state.compactionConsecutiveFailures >= state.maxCompactionFailures) {
    console.warn('[chatEngine] Compaction circuit breaker tripped — skipping compaction');
    return;
  }

  const b3WriteCount = state.toolCallLog.filter((e) =>
    isSuccessfulDirectMutation(e.tool, e.error),
  ).length;
  const b3VerifierInfo = state.lastVerifierReceipt
    ? `${state.lastVerifierReceipt.command} (exit ${state.lastVerifierReceipt.exit_code})`
    : 'none';
  const b3TodoInfo = state.todosSize > 0 ? `${state.todosSize} active` : 'none';
  const b3PhaseInfo = state.lastPhase ?? 'unknown';

  try {
    const oldLen = state.conversation.length;
    const systemIdx = state.conversation.findIndex((m) => m.role === 'system');
    const systemMsg = systemIdx >= 0 ? state.conversation[systemIdx]! : undefined;
    const keepCount = Math.max(
      4,
      state.maxConversationMessages - (systemMsg ? 1 : 0) - 2,
    );

    let startIdx = state.conversation.length - keepCount;
    if (startIdx > 0) {
      const firstKept = state.conversation[startIdx];
      if (firstKept && firstKept.role === 'tool') {
        for (let i = startIdx - 1; i >= 0; i--) {
          const m = state.conversation[i];
          if (m && m.role === 'assistant' && m.name === 'tool_calls') {
            startIdx = i;
            break;
          }
        }
      }
    }

    const finalRecent = state.conversation.slice(startIdx);
    const dropped = state.conversation.slice(
      systemIdx >= 0 ? systemIdx + 1 : 0,
      state.conversation.length - finalRecent.length,
    );

    state.conversation = systemMsg ? [systemMsg, ...finalRecent] : finalRecent;

    const skippedCount = oldLen - state.conversation.length;
    if (skippedCount > 0) {
      const summary = state.summarizeDroppedTurns(dropped);
      const compactPreamble = `[Session state: ${b3WriteCount} writes made, last verifier: ${b3VerifierInfo}, active todos: ${b3TodoInfo}, phase: ${b3PhaseInfo}]`;
      let lastUserIdx = -1;
      for (let i = state.conversation.length - 1; i >= 0; i--) {
        if (state.conversation[i]!.role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx >= 0) {
        const existing = state.conversation[lastUserIdx]!;
        state.conversation[lastUserIdx] = {
          ...existing,
          content: summary + '\n' + compactPreamble + '\n\n' + existing.content,
        };
      }
    }
    state.apiTokenCount = 0;
    state.compactionConsecutiveFailures = 0;
    console.log('[chatEngine] Compaction succeeded — circuit breaker reset');
  } catch (err) {
    state.compactionConsecutiveFailures++;
    console.warn(
      `[chatEngine] Compaction failed (${state.compactionConsecutiveFailures} consecutive failures)`,
    );
  }
}
