import { classifyToolEffect } from '../executor/contracts.js';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { resolveProjectPath } from '../utils/projectPath.js';
import type { ToolDefinition } from '../runners/base.js';

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

/** Range reads bypass the ordinary executor, so enforce its root boundary here. */
export function resolveChatRangePath(root: string, path: string): string {
  const target = realpathSync(resolveProjectPath(root, path));
  const rel = relative(realpathSync(root), target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('READ_OUTSIDE_PROJECT_DENIED');
  return target;
}
