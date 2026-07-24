/**
 * Shared mutation / verifier tool identity for the chat harness.
 *
 * `str_replace` is a first-class edit primitive and must count as a write
 * everywhere governance and evidence inspect tool logs (gate, stall, changed_files,
 * benchmark write counts). Historically only write_file / file_write / apply_patch
 * were recognized, so preferred-edit sessions could look write-less.
 *
 * Chat tools primarily log verifiers as `run_command`; the completion gate
 * must accept that name alongside shell_exec / test_run.
 */

/** Direct file-mutation tools (not sub_agent — that uses detail-string parsing). */
export const DIRECT_MUTATION_TOOLS = [
  'write_file',
  'file_write',
  'apply_patch',
  'str_replace',
] as const;

export type DirectMutationTool = (typeof DIRECT_MUTATION_TOOLS)[number];

/** Tools that count as a verifier attempt for completion-gate Rule 2. */
export const VERIFIER_ATTEMPT_TOOLS = [
  'shell_exec',
  'test_run',
  'run_command',
] as const;

export function isDirectMutationTool(tool: string): boolean {
  return (DIRECT_MUTATION_TOOLS as readonly string[]).includes(tool);
}

/**
 * Successful direct mutation: recognized write tool with no error.
 *
 * - Policy deny sets `error: 'blocked'`.
 * - Failed str_replace sets e.g. `error: 'str_replace: old_str not found'`.
 * Either must NOT satisfy the completion gate or populate changed_files.
 */
export function isSuccessfulDirectMutation(
  tool: string,
  error?: string | null,
): boolean {
  return isDirectMutationTool(tool) && (error == null || error === '');
}

export function isVerifierAttemptTool(tool: string): boolean {
  return (VERIFIER_ATTEMPT_TOOLS as readonly string[]).includes(tool);
}
