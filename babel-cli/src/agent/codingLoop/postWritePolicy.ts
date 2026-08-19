/**
 * Post-write tool policy: a successful mutation must not permanently strip
 * investigation tools. A red verifier reopens read/search/LSP. Only
 * demonstrably unproductive repeats are discouraged.
 */

import {
  buildChatToolDefinitions,
  buildRestrictedChatToolDefinitions,
  type RestrictedToolMode,
} from '../chatToolDefinitions.js'
import type { ChatTaskClass } from '../../config/chatTaskClass.js'
import type { ToolDefinition } from '../../runners/base.js'

export const INVESTIGATION_TOOL_NAMES = [
  'read_file',
  'read_range',
  'list_dir',
  'grep',
  'glob',
  'semantic_search',
  'git_context',
  'lsp',
] as const

export type NextTurnToolMode = 'full' | RestrictedToolMode

export interface NextTurnToolPolicyInput {
  /** Sticky flag historically set after the first successful write. */
  postWriteRestrict: boolean
  /** Last authoritative verifier (if any) failed. */
  lastVerifierFailed: boolean
  /** One-shot stall restrict_tools latch. */
  stallRestrictOnce: boolean
  taskClass: ChatTaskClass | string
  /** Identical reread / identical failing command / same mutation+error. */
  unproductiveRepeat?: boolean
}

export interface NextTurnToolPolicy {
  restrict: boolean
  mode: NextTurnToolMode
  reopenInvestigation: boolean
  discourageUnproductiveRepeat: boolean
}

/**
 * Decide whether the next model turn may use investigation tools.
 *
 * A write never permanently removes read/search/LSP. After a red verifier
 * the next turn is always full-access. `general_swe` keeps this behavior.
 */
export function resolveNextTurnToolAccess(input: NextTurnToolPolicyInput): NextTurnToolPolicy {
  const discourage = input.unproductiveRepeat === true
  if (input.lastVerifierFailed) {
    return {
      restrict: false,
      mode: 'full',
      reopenInvestigation: true,
      discourageUnproductiveRepeat: discourage,
    }
  }
  // Stall one-shot may still force mutate/verify for a single turn, but a
  // successful write by itself no longer sticks act_or_verify forever.
  if (input.stallRestrictOnce && !input.postWriteRestrict) {
    return {
      restrict: true,
      mode: 'mutate_only',
      reopenInvestigation: false,
      discourageUnproductiveRepeat: discourage,
    }
  }
  if (input.stallRestrictOnce && input.postWriteRestrict) {
    return {
      restrict: true,
      mode: 'act_or_verify',
      reopenInvestigation: false,
      discourageUnproductiveRepeat: discourage,
    }
  }
  return {
    restrict: false,
    mode: 'full',
    reopenInvestigation: input.postWriteRestrict,
    discourageUnproductiveRepeat: discourage,
  }
}

/**
 * Tool definitions for the next turn according to the policy.
 */
export function toolsForNextTurn(policy: NextTurnToolPolicy): ToolDefinition[] {
  if (policy.mode === 'full') return buildChatToolDefinitions()
  return buildRestrictedChatToolDefinitions(policy.mode)
}

/**
 * True when the next-turn tool list includes the required investigation set.
 */
export function investigationToolsAvailable(defs: ToolDefinition[]): boolean {
  const names = new Set(defs.map((d) => d.function.name))
  return INVESTIGATION_TOOL_NAMES.every((name) => names.has(name))
}

/**
 * Detect a demonstrably unproductive repeat that may be discouraged
 * (nudge) without removing tools.
 */
export function isUnproductiveRepeat(input: {
  identicalBroadReread?: boolean
  identicalFailingCommand?: boolean
  sameMutationAfterSameError?: boolean
}): boolean {
  return (
    input.identicalBroadReread === true ||
    input.identicalFailingCommand === true ||
    input.sameMutationAfterSameError === true
  )
}

/**
 * Deterministic post-write + red-verifier fixture used by tests and
 * ChatEngine. Simulates: mutate → red verifier → next-turn tools.
 */
export function evaluatePostWriteRepairTurn(input: {
  taskClass: ChatTaskClass | string
  firstMutationSucceeded: boolean
  verifierExitCode: number
  stallRestrictOnce?: boolean
}): {
  policy: NextTurnToolPolicy
  tools: ToolDefinition[]
  canReread: boolean
  canSearch: boolean
  canUseLsp: boolean
  canRepairAgain: boolean
} {
  const policy = resolveNextTurnToolAccess({
    postWriteRestrict: input.firstMutationSucceeded,
    lastVerifierFailed: input.verifierExitCode !== 0,
    stallRestrictOnce: input.stallRestrictOnce === true,
    taskClass: input.taskClass,
  })
  const tools = toolsForNextTurn(policy)
  const names = new Set(tools.map((d) => d.function.name))
  return {
    policy,
    tools,
    canReread: names.has('read_file') && names.has('read_range'),
    canSearch: names.has('grep') && names.has('glob'),
    canUseLsp: names.has('lsp'),
    canRepairAgain: names.has('str_replace') || names.has('write_file') || names.has('apply_patch'),
  }
}
