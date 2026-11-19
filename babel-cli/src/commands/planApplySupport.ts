// License: Apache-2.0
// W11 Plan-apply command support. Kept out of workflowCommands.ts because the
// repository's architectural ratchet forbids files over 2,000 lines from
// growing, and these are additive Plan/apply surfaces rather than changes to
// shared workflow code.
import * as readline from 'node:readline/promises';
import { invokedCliName } from '../cli/commandName.js';
import { isReadOnlyChat } from '../agent/chatReadOnly.js';
import { readRuntimeMode } from '../config/runtimeMode.js';
import { PLAN_APPLY_UNAVAILABLE_REASON } from '../agent/planHandoff.js';
import { withSavedPlanApplication, type SavedPlan } from '../services/savedPlan.js';

export const APPLY_DESCRIPTION = 'Apply a saved plan ID, or resume a legacy manual Plan through --run/--plan <path>';
export const APPLY_RUN_OPTION = 'Legacy manual-bridge run directory';
export const APPLY_PROJECT_OPTION = 'Target project for the saved Plan or manual run';
export const APPLY_PLAN_OPTION = 'Saved Plan ID, or a legacy manual Plan path (use - for stdin, clipboard for the clipboard)';
export const APPLY_YES_OPTION = 'Confirm applying the saved Plan without an interactive prompt';
export const APPLY_HELP = `
Notes:
  - A saved Plan ID (plan_...) applies through the guarded route and asks for
    confirmation on an interactive terminal. Non-interactive callers must pass
    --yes explicitly.
  - The saved Plan source, project identity, fingerprint, permissions and
    read-only mode are rechecked before any mutation.
  - --run and non-ID --plan values enter the separate legacy manual-bridge
    lane. Its artifacts and admission checks are its own; it does not use the
    saved-Plan confirmation.
`;

export const RESUME_DESCRIPTION = 'Inspect resume evidence; saved-run action resume is unavailable, legacy --run/--plan remains explicit';
export const RESUME_RUN_OPTION = 'Legacy manual-bridge run directory';
export const RESUME_PLAN_OPTION = 'Legacy manual Plan path (use - for stdin, clipboard for the clipboard)';
export const RESUME_HELP = `
Examples:
  $ babel-harness resume latest
  $ bl resume latest

Important:
  - Saved-run action resume is temporarily unavailable until task identity, settlement, and verifier authority are qualified.
  - babel continue latest --inspect-only inspects saved runs without taking an action.
  - Legacy manual Plan resume remains available explicitly through
    resume --run <run_dir> --plan <path>; retained artifacts are never
    rewritten. It is a separate compatibility lane from a saved-Plan apply.
`;

/** Interactive confirmation for an explicitly requested saved-Plan apply. */
export async function promptPlanApproval(task: string, autoApprove = false): Promise<boolean> {
  if (autoApprove) {
    process.stderr.write(`Auto-approved via --yes: ${task}\n`);
    return true;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return false;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    process.stderr.write('\n');
    process.stderr.write('Approve this plan and apply it now? [y/N] ');
    const answer = (await rl.question('')).trim().toLowerCase();
    if (/^(?:y|yes|approve|approved|apply|go)$/i.test(answer)) {
      process.stderr.write(`Applying approved task: ${task}\n`);
      return true;
    }
    process.stderr.write('Kept as plan-only. No files were changed.\n');
    return false;
  } finally {
    rl.close();
  }
}

/** Saved-Plan apply is advertised only when this profile could admit it. */
export function planApplyCapability(savedPlanId: string | null, env: NodeJS.ProcessEnv = process.env): { available: boolean; reason: string | null } {
  if (!savedPlanId) return { available: false, reason: null }
  if (isReadOnlyChat(env) || /^(?:1|true)$/i.test(env['BABEL_DRY_RUN'] ?? '') || readRuntimeMode(env) === 'plan') {
    return { available: false, reason: 'Current read-only permissions block plan application.' }
  }
  return { available: true, reason: null }
}

/** Annotate a Plan result with the capability the CLI can actually honor. */
export function annotatePlanApplyPayload(payload: Record<string, unknown>, savedPlanId: string | null, humanText: string | null): string | null {
  payload['apply_available'] = false;
  payload['apply_unavailable_reason'] = PLAN_APPLY_UNAVAILABLE_REASON;
  // Automatic application and an explicit saved Plan apply are different
  // capabilities. Neither surface may advertise the explicit route unless a
  // canonical saved Plan id exists and this profile could actually admit it;
  // that route rechecks source scope and asks for confirmation before any
  // mutation.
  const applyCapability = planApplyCapability(savedPlanId);
  payload['explicit_apply_available'] = applyCapability.available;
  payload['apply_requires_confirmation'] = applyCapability.available;
  if (savedPlanId) payload['plan_id'] = savedPlanId;
  if (applyCapability.reason) payload['explicit_apply_unavailable_reason'] = applyCapability.reason;
  if (savedPlanId && applyCapability.available) payload['apply_command'] = `${invokedCliName()} apply --plan ${savedPlanId}`;
  return [humanText,
    savedPlanId ? `Plan saved as ${savedPlanId}.` : 'The Plan is retained in its run evidence; canonical saving is unavailable.',
    savedPlanId && applyCapability.available ? `Apply: ${payload['apply_command']} (asks for confirmation; source scope is rechecked).` : null,
    savedPlanId && !applyCapability.available ? applyCapability.reason : null,
    PLAN_APPLY_UNAVAILABLE_REASON].filter(Boolean).join('\n');
}

/** Human hint after a saved Plan is produced but no automatic application ran. */
export function planSavedApplyHint(id: string): string {
  return `Plan saved as ${id}. No project files were changed. Apply: ${invokedCliName()} apply --plan ${id} (asks for confirmation)\n`;
}

/** The one guarded saved-Plan apply route: admission, confirmation, execution. */
export async function applySavedPlanWithConfirmation<T>(id: string, options: {
  projectRoot: string;
  yes?: boolean;
  execute: (plan: SavedPlan) => Promise<T>;
}): Promise<T> {
  return withSavedPlanApplication(id, {
    projectRoot: options.projectRoot,
    preflight: async plan => {
      if (!(await promptPlanApproval(plan.task, options.yes === true))) {
        throw new Error('Plan application was not confirmed; no files were changed.');
      }
    },
    execute: options.execute,
  });
}
