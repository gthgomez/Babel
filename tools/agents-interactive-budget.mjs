// License: Apache-2.0 — see LICENSE
/** Matches babel-cli/src/agent/chatStackCompile.ts INTERACTIVE_STACK_BUDGET. */
export const INTERACTIVE_STACK_BUDGET = 12_000

/**
 * Required identity length for committed AGENTS.md bytes: JavaScript UTF-16 code units
 * after Node's UTF-8 decode (readFileSync(..., 'utf8').length), including a preserved BOM.
 */
export function requiredIdentityLengthFromUtf8(bytes) {
  return Buffer.from(bytes).toString('utf8').length
}

/**
 * Fail closed when a single repository-root AGENTS.md body (exact committed or staged
 * bytes) exceeds the interactive budget. Does not compile nested instruction sources or
 * substitute for chatStackCompile LF/CRLF canonical admission tests on policy edits.
 */
export function assertInteractiveAgentsBudget(bytes, { label = 'AGENTS.md' } = {}) {
  const length = requiredIdentityLengthFromUtf8(bytes)
  if (length > INTERACTIVE_STACK_BUDGET) {
    throw new Error(
      `required_instruction_exceeds_prompt_budget (${label} length=${length} budget=${INTERACTIVE_STACK_BUDGET})`,
    )
  }
  return length
}
