// License: Apache-2.0 — see LICENSE
/** Matches babel-cli/src/agent/chatStackCompile.ts INTERACTIVE_STACK_BUDGET. */
export const INTERACTIVE_STACK_BUDGET = 12_000

/**
 * Required identity length for a single AGENTS.md body: JavaScript UTF-16 code units
 * after strict UTF-8 decode (same as readFileSync(..., 'utf8').length in compileChatStack).
 */
export function requiredIdentityLengthFromUtf8(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return text.length
}

/** Fail closed when committed/staged AGENTS.md exceeds the interactive stack budget. */
export function assertInteractiveAgentsBudget(bytes, { label = 'AGENTS.md' } = {}) {
  const length = requiredIdentityLengthFromUtf8(bytes)
  if (length > INTERACTIVE_STACK_BUDGET) {
    throw new Error(
      `required_instruction_exceeds_prompt_budget (${label} length=${length} budget=${INTERACTIVE_STACK_BUDGET})`,
    )
  }
  return length
}
