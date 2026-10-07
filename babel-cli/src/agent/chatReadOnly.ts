import { classifyToolEffect } from '../executor/contracts.js';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { resolveProjectPath } from '../utils/projectPath.js';
import { isCredentialTargetPath } from './autonomyEnforcement.js';
import { isOfflineChatMode } from './chatModelPolicy.js';
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
  // External reads are not repository writes. Offline mode and unknown MCP
  // effects stay denied. A read-only child cannot widen this set.
  if (tool === 'web_search' || tool === 'web_fetch') return !isOfflineChatMode();
  if (tool === 'sub_agent') return true;
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

export type ContentReadAdmission =
  | { ok: true; target: string }
  | { ok: false; code: 'AUTONOMY_DENIED:CLASS_D' | 'READ_OUTSIDE_PROJECT_DENIED'; message: string };

function pathEscapesRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '..' || isAbsolute(rel) || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || rel.startsWith('../') || rel.startsWith('..\\');
}

/**
 * Admit a content read before any content I/O. Credential class and outside-root
 * targets, including symlink escapes, are refused from the lexical path first.
 * realpath is used only after the credential class check, and only to prove
 * containment. It is not a content read.
 */
export function admitProjectContentRead(root: string, requestedPath: string): ContentReadAdmission {
  if (isCredentialTargetPath(requestedPath)) {
    return {
      ok: false,
      code: 'AUTONOMY_DENIED:CLASS_D',
      message: `Target path "${requestedPath}" is a credential store.`,
    };
  }
  const lexical = resolve(resolveProjectPath(root, requestedPath));
  if (isCredentialTargetPath(lexical)) {
    return {
      ok: false,
      code: 'AUTONOMY_DENIED:CLASS_D',
      message: `Target path "${requestedPath}" is a credential store.`,
    };
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { ok: false, code: 'READ_OUTSIDE_PROJECT_DENIED', message: 'Project root is not readable.' };
  }
  if (pathEscapesRoot(resolve(root), lexical)) {
    return { ok: false, code: 'READ_OUTSIDE_PROJECT_DENIED', message: 'READ_OUTSIDE_PROJECT_DENIED' };
  }
  let target = lexical;
  try {
    const stat = lstatSync(lexical);
    if (stat.isSymbolicLink() || stat.isFile() || stat.isDirectory()) {
      target = realpathSync(lexical);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      return { ok: false, code: 'READ_OUTSIDE_PROJECT_DENIED', message: 'READ_OUTSIDE_PROJECT_DENIED' };
    }
  }
  if (isCredentialTargetPath(target) || pathEscapesRoot(rootReal, target)) {
    return {
      ok: false,
      code: isCredentialTargetPath(target) ? 'AUTONOMY_DENIED:CLASS_D' : 'READ_OUTSIDE_PROJECT_DENIED',
      message: isCredentialTargetPath(target)
        ? `Target path "${requestedPath}" is a credential store.`
        : 'READ_OUTSIDE_PROJECT_DENIED',
    };
  }
  return { ok: true, target };
}

/** Range reads bypass the ordinary executor, so enforce its root boundary here. */
export function resolveChatRangePath(root: string, path: string): string {
  const admitted = admitProjectContentRead(root, path);
  if (!admitted.ok) throw new Error(admitted.code);
  return admitted.target;
}
