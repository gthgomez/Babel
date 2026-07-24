/**
 * Plan-then-execute enforcement.
 *
 * For tasks above a size threshold (or playbooks with requireTodoPlan),
 * block direct file mutations until the agent has created at least one todo via
 * `todo_write`. Prompt-only multi-file warnings are insufficient; this is a
 * hard harness gate.
 *
 * Scope (intentional): only direct mutation tools (write_file / file_write /
 * apply_patch / str_replace) and mutation-enabled sub_agent. Shell tools
 * (`run_command`, `shell_exec`, `test_run`) are NOT blocked — agents must still
 * explore and run verifiers before a plan exists. Treat shell side-effects as
 * a separate policy surface, not part of this gate.
 *
 * Chat / REPL note: the default word threshold (80) also applies to free-form
 * chat tasks without a playbook. Long pastes can require `todo_write` before
 * edits — disable with BABEL_REQUIRE_TODO_PLAN=0 or raise
 * BABEL_TODO_PLAN_WORD_THRESHOLD for looser REPL behavior.
 *
 * Disable: BABEL_REQUIRE_TODO_PLAN=0
 * Force on: BABEL_REQUIRE_TODO_PLAN=1
 * Word threshold (default 80): BABEL_TODO_PLAN_WORD_THRESHOLD
 */

import type { PlaybookDefinition } from '../services/playbooks/playbookService.js';
import { isDirectMutationTool } from './mutationTools.js';

const DEFAULT_WORD_THRESHOLD = 80;

export function resolveTodoPlanWordThreshold(): number {
  const raw = process.env['BABEL_TODO_PLAN_WORD_THRESHOLD'];
  if (raw == null || raw === '') return DEFAULT_WORD_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WORD_THRESHOLD;
}

export function countTaskWords(task: string): number {
  return task
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

/**
 * Whether the harness should hard-require a todo list before mutations.
 */
export function shouldRequireTodoPlan(
  task: string,
  playbook?: PlaybookDefinition | null,
): boolean {
  const env = process.env['BABEL_REQUIRE_TODO_PLAN'];
  if (env === '0' || env === 'false') return false;
  if (env === '1' || env === 'true') return true;

  if (playbook?.requireTodoPlan) return true;

  // Multi-file skill tags always require a plan
  const skills = playbook?.select?.skills ?? [];
  if (skills.includes('multi_file') || skills.includes('multi_hunk')) return true;

  // Size threshold for complex free-form tasks
  if (countTaskWords(task) >= resolveTodoPlanWordThreshold()) return true;

  return false;
}

export interface PlanGateResult {
  blocked: boolean;
  observation?: string;
}

/**
 * Gate a single tool call. Returns blocked=true with observation when the
 * model attempted a mutation before planning.
 */
export function evaluatePlanThenExecuteGate(opts: {
  toolName: string;
  requirePlan: boolean;
  todoCount: number;
  /** sub_agent with mutation:true also counts as a mutation */
  isMutationSubAgent?: boolean;
}): PlanGateResult {
  if (!opts.requirePlan || opts.todoCount > 0) {
    return { blocked: false };
  }

  const isMutation =
    isDirectMutationTool(opts.toolName) || opts.isMutationSubAgent === true;

  if (!isMutation) {
    return { blocked: false };
  }

  return {
    blocked: true,
    observation:
      `### ${opts.toolName}\nexit_code: 1\n` +
      `Error: plan-then-execute — mutations are blocked until you call \`todo_write\` ` +
      `with at least one task item. Create a short plan first, then re-attempt the edit.`,
  };
}
