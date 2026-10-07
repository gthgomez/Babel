import { classifyToolEffect } from '../executor/contracts.js';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { resolveProjectPath } from '../utils/projectPath.js';
import type { ToolDefinition } from '../runners/base.js';
import type { TaskOperation } from '../config/chatTaskClass.js';
import type { ChatToolAction } from './chatToolDefinitions.js';

/** Read-only is orthogonal to Chat/Plan/Deep and applies before fast paths. */
export function isReadOnlyChat(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['BABEL_READ_ONLY'] === 'true' || env['BABEL_EXECUTION_PROFILE'] === 'read_only_audit';
}

export function deniesReadOnlyChatAction(action: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isReadOnlyChat(env)) return false;
  // No shared memory or delegation outside this fresh read-only capability set.
  return !['read_file', 'read_range', 'list_dir', 'grep', 'glob'].includes(action)
    || classifyToolEffect(action === 'search' ? 'semantic_search' : action) !== 'read_only';
}

/** Advertise the same capabilities that dispatch enforces, not unusable tools. */
export function filterReadOnlyChatTools(tools: ToolDefinition[], env: NodeJS.ProcessEnv = process.env): ToolDefinition[] {
  return isReadOnlyChat(env) ? tools.filter(tool => !deniesReadOnlyChatAction(tool.function.name, env)) : tools;
}

function allowsReadOnlyTaskTool(tool: string, requiredVerifiers: readonly string[]): boolean {
  return classifyToolEffect(tool) === 'read_only'
    || tool === 'finish' || tool === 'todo_write'
    || ((tool === 'run_command' || tool === 'test_run') && requiredVerifiers.length > 0);
}

/** One name projection for native schemas and text/legacy manuals; admission still checks actions. */
export function filterChatToolNamesForTask(
  names: readonly string[], operation: TaskOperation | undefined, requiredVerifiers: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return names.filter(name => !deniesReadOnlyChatAction(name, env)
    && (operation !== 'READ_ONLY' || allowsReadOnlyTaskTool(name, requiredVerifiers)));
}

/** Accepted task scope narrows ordinary Chat; it never broadens profile grants. */
export function deniesReadOnlyTaskAction(
  action: ChatToolAction,
  operation: TaskOperation | undefined,
  requiredVerifiers: readonly string[],
): boolean {
  if (operation !== 'READ_ONLY') return false;
  if (!allowsReadOnlyTaskTool(action.type, requiredVerifiers)) return true;
  if (action.type === 'run_command' || action.type === 'test_run') {
    if (action.type === 'run_command' && (action.background || action.detached)) return true;
    // Checker coverage/family matching is evidence logic, not authority to run
    // extra commands. The existing executor still applies profile/grant policy.
    return !requiredVerifiers.some(command => command.trim() === action.command.trim());
  }
  return false;
}

/** Native advertisement projects the same accepted scope as action admission. */
export function filterReadOnlyTaskTools(
  tools: ToolDefinition[], operation: TaskOperation | undefined, requiredVerifiers: readonly string[],
): ToolDefinition[] {
  return operation === 'READ_ONLY'
    ? tools.filter(tool => allowsReadOnlyTaskTool(tool.function.name, requiredVerifiers)) : tools;
}

/** Range reads bypass the ordinary executor, so enforce its root boundary here. */
export function resolveChatRangePath(root: string, path: string): string {
  const target = realpathSync(resolveProjectPath(root, path));
  const rel = relative(realpathSync(root), target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('READ_OUTSIDE_PROJECT_DENIED');
  return target;
}
