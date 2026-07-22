/**
 * Tool executor lane — maps normalized `AgentAction` values to `executeTool` calls.
 *
 * AgentAction → executeTool mapping:
 *
 * | AgentAction.type | executeTool                         | Notes |
 * |------------------|-------------------------------------|-------|
 * | read_file        | file_read                           | read-only |
 * | list_dir         | directory_list                      | read-only |
 * | search           | semantic_search                     | read-only repo index |
 * | write_file       | file_write                          | mutating |
 * | apply_patch      | file_write + shell_exec             | writes `.babel-lite/apply.patch`, then `git apply` |
 * | run_command      | shell_exec or test_run              | `test_run` when command looks like a test invocation |
 * | finish           | (none)                              | terminal — loop should verify + checkpoint |
 * | ask_approval     | (none)                              | terminal — loop should pause for user approval |
 */

import { executeTool, type ToolCallRequest, type ToolContext, type ToolResult } from '../localTools.js';
import type { AgentAction } from './actions.js';
import { decideAction, type PermissionDecision, type PermissionPreset } from './policy.js';

const APPLY_PATCH_RELATIVE_PATH = '.babel-lite/apply.patch';

export type TerminalAgentAction = Extract<AgentAction, { type: 'finish' | 'ask_approval' }>;

export type MappedToolCall =
  | { kind: 'execute'; request: ToolCallRequest }
  | { kind: 'terminal'; action: TerminalAgentAction };

export interface ToolExecutionResult {
  action: AgentAction;
  terminal: boolean;
  results: ToolResult[];
}

export interface PolicyGatedExecutionResult extends ToolExecutionResult {
  policyDecision: PermissionDecision;
  policyBlocked: boolean;
}

export interface ToolExecutor {
  mapAction(action: AgentAction): MappedToolCall[];
  execute(action: AgentAction, context: ToolContext): Promise<ToolExecutionResult>;
}

function looksLikeTestCommand(command: string): boolean {
  return /\b(npm\s+test|pnpm\s+test|yarn\s+test|pytest|jest|vitest|cargo\s+test|go\s+test|dotnet\s+test)\b/i.test(command);
}

function runCommandToolRequest(action: Extract<AgentAction, { type: 'run_command' }>): ToolCallRequest {
  const base = {
    command: action.command,
    ...(action.cwd ? { working_directory: action.cwd } : {}),
  };

  if (looksLikeTestCommand(action.command)) {
    return { tool: 'test_run', ...base };
  }

  return { tool: 'shell_exec', ...base };
}

/** Map one agent action to zero or more executor tool calls (terminal actions map to none). */
export function mapAgentActionToToolCalls(action: AgentAction): MappedToolCall[] {
  switch (action.type) {
    case 'read_file':
      return [{ kind: 'execute', request: { tool: 'file_read', path: action.path } }];
    case 'list_dir':
      return [{ kind: 'execute', request: { tool: 'directory_list', path: action.path } }];
    case 'search':
      return [{ kind: 'execute', request: { tool: 'semantic_search', query: action.query } }];
    case 'write_file':
      return [{ kind: 'execute', request: { tool: 'file_write', path: action.path, content: action.content } }];
    case 'apply_patch':
      return [
        {
          kind: 'execute',
          request: {
            tool: 'file_write',
            path: APPLY_PATCH_RELATIVE_PATH,
            content: action.patch,
          },
        },
        {
          kind: 'execute',
          request: {
            tool: 'shell_exec',
            command: `git apply --unsafe-paths ${APPLY_PATCH_RELATIVE_PATH}`,
          },
        },
      ];
    case 'run_command':
      return [{ kind: 'execute', request: runCommandToolRequest(action) }];
    case 'finish':
    case 'ask_approval':
      return [{ kind: 'terminal', action }];
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export function isTerminalAgentAction(action: AgentAction): action is TerminalAgentAction {
  return action.type === 'finish' || action.type === 'ask_approval';
}

export function createToolExecutor(deps: {
  executeTool?: typeof executeTool;
} = {}): ToolExecutor {
  const runTool = deps.executeTool ?? executeTool;

  return {
    mapAction(action: AgentAction): MappedToolCall[] {
      return mapAgentActionToToolCalls(action);
    },

    async execute(action: AgentAction, context: ToolContext): Promise<ToolExecutionResult> {
      const mapped = mapAgentActionToToolCalls(action);
      const terminal = mapped.find((entry): entry is Extract<MappedToolCall, { kind: 'terminal' }> => entry.kind === 'terminal');

      if (terminal) {
        return {
          action,
          terminal: true,
          results: [],
        };
      }

      const results: ToolResult[] = [];
      for (const entry of mapped) {
        if (entry.kind !== 'execute') {
          continue;
        }
        results.push(await runTool(entry.request, context));
      }

      return {
        action,
        terminal: false,
        results,
      };
    },
  };
}

export const defaultToolExecutor = createToolExecutor();

function policyBlockedToolResult(action: AgentAction, decision: PermissionDecision): ToolResult {
  const reason = decision === 'deny'
    ? `Policy denied ${action.type}`
    : `Policy requires approval before ${action.type}`;
  return {
    exit_code: 1,
    stdout: '',
    stderr: reason,
  };
}

/**
 * Execute one agent action after `decideAction()` — central policy gate for tool calls.
 * Deny and ask decisions block execution; allow proceeds through the tool executor.
 */
export async function executeActionWithPolicy(
  action: AgentAction,
  preset: PermissionPreset,
  context: ToolContext,
  deps: {
    executor?: ToolExecutor;
    decide?: typeof decideAction;
  } = {},
): Promise<PolicyGatedExecutionResult> {
  const executor = deps.executor ?? defaultToolExecutor;
  const decide = deps.decide ?? decideAction;
  const policyDecision = decide(action, preset);

  if (policyDecision !== 'allow') {
    return {
      action,
      terminal: isTerminalAgentAction(action),
      results: [policyBlockedToolResult(action, policyDecision)],
      policyDecision,
      policyBlocked: true,
    };
  }

  const execution = await executor.execute(action, context);
  return {
    ...execution,
    policyDecision,
    policyBlocked: false,
  };
}
