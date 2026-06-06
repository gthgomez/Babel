import type { ExecutionProfileName } from '../config/executionProfiles.js';
import type { AgentAction } from './actions.js';
import type { LiteSessionVerb } from './contracts.js';

export type PermissionDecision = 'allow' | 'ask' | 'deny';

export type PermissionPreset = 'read_only' | 'workspace_write' | 'ask_before_mutation' | 'auto_safe';

export const READ_ONLY_LITE_TOOLS = [
  'directory_list',
  'file_read',
  'semantic_search',
  'web_search',
  'web_fetch',
] as const;

const MUTATING_ACTIONS = new Set<AgentAction['type']>([
  'write_file',
  'apply_patch',
  'run_command',
]);

export function presetForVerb(verb: LiteSessionVerb): PermissionPreset {
  if (verb === 'ask' || verb === 'plan' || verb === 'propose' || verb === 'diff' || verb === 'patch' || verb === 'review' || verb === 'undo') {
    return 'read_only';
  }
  return 'workspace_write';
}

export function executionProfileForPreset(preset: PermissionPreset): ExecutionProfileName {
  if (preset === 'read_only') {
    return 'read_only_audit';
  }
  return 'safe_repo';
}

export function allowedToolsForVerb(verb: LiteSessionVerb): string[] {
  const preset = presetForVerb(verb);
  return preset === 'read_only' ? [...READ_ONLY_LITE_TOOLS] : [];
}

export function decideAction(
  action: AgentAction,
  preset: PermissionPreset,
): PermissionDecision {
  if (preset === 'read_only' && MUTATING_ACTIONS.has(action.type)) {
    return 'deny';
  }
  if (preset === 'ask_before_mutation' && MUTATING_ACTIONS.has(action.type)) {
    return 'ask';
  }
  if (action.type === 'run_command' && /\b(curl|wget|npm\s+install|pnpm\s+add|yarn\s+add)\b/i.test(action.command)) {
    return preset === 'auto_safe' ? 'ask' : 'deny';
  }
  return 'allow';
}

/** Deny-overrides-allow: explicit deny wins over allow. */
export function mergeDecisions(...decisions: PermissionDecision[]): PermissionDecision {
  if (decisions.includes('deny')) return 'deny';
  if (decisions.includes('ask')) return 'ask';
  return 'allow';
}
