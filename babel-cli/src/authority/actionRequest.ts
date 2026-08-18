/**
 * actionRequest.ts — canonical AgentAction → ActionRequest mapping.
 *
 * Every normalized effectful action maps to exactly one capability while a
 * lease is active. Control actions (finish, ask_approval) return null and
 * are not an authority source.
 */

import type { AgentAction } from '../agent/actions.js';
import { parseGitCommand } from './gitCommand.js';
import { isPrivilegedCapability } from './capabilities.js';
import type { ActionRequest } from './pdp.js';

function fromParsedCommand(command: string): ActionRequest {
  const parsed = parseGitCommand(command);
  return {
    capability: parsed.capability,
    ...(parsed.remote !== undefined ? { remote: parsed.remote } : {}),
    ...(parsed.destinationBranch !== undefined ? { destinationBranch: parsed.destinationBranch } : {}),
    ...(parsed.sourceBranch !== undefined ? { sourceBranch: parsed.sourceBranch } : {}),
    ...(parsed.target !== undefined ? { target: parsed.target } : {}),
    ...(parsed.environment !== undefined ? { environment: parsed.environment } : {}),
    force: parsed.force,
    delete: parsed.delete,
    ...(parsed.requiresIsolation === true ? { requiresIsolation: true } : {}),
  };
}

/**
 * Map a normalized action to a PDP ActionRequest.
 * Returns null only for non-effectful control actions.
 */
export function actionRequestFromAction(action: AgentAction): ActionRequest | null {
  switch (action.type) {
    case 'read_file':
    case 'list_dir':
    case 'git_context':
    case 'workspace_map':
      return { capability: 'inspect_repository' };
    case 'search':
    case 'grep':
    case 'glob':
      return { capability: 'search_repository' };
    case 'write_file':
      return { capability: 'edit_task_files', target: action.path };
    case 'apply_patch':
      return { capability: 'edit_task_files' };
    case 'test_run': {
      const decoded = fromParsedCommand(action.command);
      if (
        isPrivilegedCapability(decoded.capability) ||
        decoded.capability === 'expose_credentials' ||
        decoded.capability === 'unknown' ||
        decoded.capability === 'run_local_command'
      ) {
        return decoded;
      }
      return { ...decoded, capability: 'run_tests', requiresIsolation: true };
    }
    case 'run_command':
      return fromParsedCommand(action.command);
    case 'finish':
    case 'ask_approval':
      return null;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export function isControlAgentAction(action: AgentAction): boolean {
  return action.type === 'finish' || action.type === 'ask_approval';
}
