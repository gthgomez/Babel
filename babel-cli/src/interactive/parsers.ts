// ─── Input Parsers ────────────────────────────────────────────────────────────
// Extracted from interactive.ts — parseInteractiveDailyCommand and
// classifyInteractiveTaskIntent. These are the two publicly-exported parser
// functions used by the REPL dispatch and by external consumers (tests).

import { classifyDoTask } from '../commands/workflowCommands.js';
import {
  DAILY_COMMAND_VERBS,
  AMBIGUOUS_CONFIRMATION_PATTERN,
  EXPLICIT_FOLLOW_UP_FIX_PATTERN,
  APPROVAL_READY_STATUSES,
  EXPLICIT_GOVERNED_PATTERN,
  PLANNING_INTENT_PATTERN,
  DIRECT_MUTATION_PATTERN,
  type InteractiveTaskIntentOptions,
  type InteractiveDailyCommand,
} from './types.js';
import type { LiteSessionVerb } from '../agent/contracts.js';

export function parseInteractiveDailyCommand(input: string): InteractiveDailyCommand | null {
  const match = input.trim().match(/^(bl|babel)\s+([a-z][a-z-]*)\b(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }
  const prefix = match[1]?.toLowerCase();
  const rawVerb = match[2]?.toLowerCase();
  if (prefix !== 'bl' && prefix !== 'babel') {
    return null;
  }
  if (rawVerb === 'run' || rawVerb === 'advanced' || rawVerb === 'help') {
    return null;
  }
  if (rawVerb === 'deep' || rawVerb === 'full') {
    return {
      prefix,
      verb: 'deep',
      task: (match[3] ?? '').trim(),
    };
  }
  if (rawVerb && DAILY_COMMAND_VERBS.has(rawVerb as LiteSessionVerb)) {
    return {
      prefix,
      verb: rawVerb as LiteSessionVerb,
      task: (match[3] ?? '').trim(),
    };
  }
  const task = input
    .trim()
    .replace(/^(bl|babel)\s+/i, '')
    .trim();
  if (!task) {
    return null;
  }
  return {
    prefix,
    verb: 'do',
    task,
  };
}

export function classifyInteractiveTaskIntent(
  input: string,
  options: boolean | InteractiveTaskIntentOptions = {},
): Exclude<LiteSessionVerb, 'do'> | 'governed' | 'ambiguous_confirmation' {
  const normalized = input.trim();
  const intentOptions = typeof options === 'boolean' ? { hasPreviousAnswer: options } : options;
  const hasPreviousAnswer = intentOptions.hasPreviousAnswer === true;
  const lastStatus = intentOptions.lastStatus ?? null;

  if (hasPreviousAnswer && AMBIGUOUS_CONFIRMATION_PATTERN.test(normalized)) {
    if (lastStatus && APPROVAL_READY_STATUSES.has(lastStatus)) {
      return lastStatus === 'PROPOSAL_READY' || lastStatus === 'PATCH_READY' ? 'patch' : 'fix';
    }
    return 'ambiguous_confirmation';
  }
  if (hasPreviousAnswer && EXPLICIT_FOLLOW_UP_FIX_PATTERN.test(normalized)) {
    if (lastStatus === 'PROPOSAL_READY' || lastStatus === 'PATCH_READY') {
      return 'patch';
    }
    return 'fix';
  }
  if (EXPLICIT_GOVERNED_PATTERN.test(normalized)) {
    return 'governed';
  }
  if (PLANNING_INTENT_PATTERN.test(normalized) && !DIRECT_MUTATION_PATTERN.test(normalized)) {
    return 'plan';
  }
  return classifyDoTask(normalized);
}
