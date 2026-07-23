/**
 * planView.ts — Interactive plan review for Plan mode.
 *
 * Displays a structured plan with step details, file paths, and operation types.
 * Provides keyboard-driven approve / edit / reject flow.
 * Mirrors Claude Code's plan mode: review → approve → execute (or edit/reject).
 */

import { withRawStdinPrompt } from './inputCoordinator.js';
import { installKeyHandler, type KeyEvent } from './keyInput.js';
import {
  accentBright,
  muted,
  primary,
  bold,
  dim,
  success,
  warning,
  info,
  getTerminalWidth,
  hyperlinkFile,
} from './theme.js';

export interface PlanStep {
  description: string;
  tool?: string;
  target?: string;
  TargetFile?: string; // legacy field
  path?: string; // legacy field
  TargetContent?: string;
  operation?: 'read' | 'write' | 'shell' | 'test' | 'unknown';
}

export interface DisplayPlan {
  taskSummary?: string;
  planType?: string;
  steps: PlanStep[];
  estimatedFiles?: string[];
  runDir?: string;
}

export type PlanDecision = 'approve' | 'edit' | 'reject';

function resolveStepOperation(step: PlanStep): 'read' | 'write' | 'shell' | 'test' | 'unknown' {
  if (step.operation) return step.operation;
  const tool = (step.tool ?? '').toLowerCase();
  if (/read|directory_list|semantic_search|grep|glob|web_search|web_fetch/i.test(tool))
    return 'read';
  if (/write|patch|replace/i.test(tool)) return 'write';
  if (/shell|exec|command/i.test(tool)) return 'shell';
  if (/test|verify|check/i.test(tool)) return 'test';
  return 'unknown';
}

function operationSymbol(op: string): string {
  switch (op) {
    case 'read':
      return dim('[R]');
    case 'write':
      return accentBright('[W]');
    case 'shell':
      return warning('[!]');
    case 'test':
      return info('[T]');
    default:
      return muted('[·]');
  }
}

function resolveTargetFile(step: PlanStep): string {
  return step.target ?? step.TargetFile ?? step.path ?? '';
}

/**
 * Render the plan to stdout and wait for user decision.
 * Returns 'approve', 'edit', or 'reject'. Returns null on cancel (Ctrl+C).
 *
 * Non-TTY / offline mode: auto-approves and returns 'approve'.
 */
export async function renderInteractivePlan(plan: DisplayPlan): Promise<PlanDecision | null> {
  if (process.env['BABEL_PIPELINE_V9_OFFLINE'] === '1') return 'approve';
  if (!process.stdout.isTTY) return 'approve';

  const width = getTerminalWidth();

  return withRawStdinPrompt(
    () =>
      new Promise((resolve) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        const steps = plan.steps;

        const render = () => {
          stdout.write('[2J[H'); // clear screen, cursor home
          stdout.write(
            `\n  ${bold(primary('Babel Plan'))} ${muted('·')} ${accentBright(plan.planType ?? 'IMPLEMENTATION_PLAN')}\n`,
          );
          if (plan.taskSummary) {
            stdout.write(`  ${muted(plan.taskSummary.slice(0, width - 4))}\n`);
          }
          stdout.write(`  ${dim('─'.repeat(Math.min(width, 80)))}\n\n`);

          if (steps.length === 0) {
            stdout.write(`  ${muted('(No action steps — read-only plan)')}\n\n`);
          }

          for (let i = 0; i < Math.min(steps.length, 12); i++) {
            const step = steps[i]!;
            const op = resolveStepOperation(step);
            const file = resolveTargetFile(step);
            const desc = step.description || '(unnamed step)';

            stdout.write(
              `  ${dim(String(i + 1).padStart(2))}. ${operationSymbol(op)} ${primary(desc.slice(0, width - 20))}\n`,
            );
            if (file) {
              stdout.write(`     ${dim('└─')} ${hyperlinkFile(file, info(file))}\n`);
            }
          }

          if (steps.length > 12) {
            stdout.write(`  ${muted(`... and ${steps.length - 12} more steps`)}\n`);
          }

          if (plan.estimatedFiles && plan.estimatedFiles.length > 0) {
            stdout.write(
              `\n  ${muted('Estimated files:')} ${plan.estimatedFiles.slice(0, 5).join(', ')}\n`,
            );
          }

          stdout.write(`\n  ${dim('─'.repeat(Math.min(width, 80)))}\n`);
          stdout.write(
            `  ${bold('[A]')} ${success('Approve')}  ${bold('[E]')} ${accentBright('Edit prompt')}  ${bold('[R]')} ${warning('Reject')}  ${dim('(or Ctrl+C to cancel)')}\n`,
          );
        };

        // migrated from readline.emitKeypressEvents to installKeyHandler
        const cleanupKeys = installKeyHandler(stdin, (event: KeyEvent) => {
          const name = event.name;

          if (name === 'a' && !event.ctrl) {
            cleanupKeys();
            stdout.write(
              `\n${success('>> Plan approved')} — promoting to Deep mode for execution...\n\n`,
            );
            resolve('approve');
          } else if (name === 'e' && !event.ctrl) {
            cleanupKeys();
            resolve('edit');
          } else if (name === 'r' && !event.ctrl) {
            cleanupKeys();
            stdout.write(`\n${warning('[x] Plan rejected.')}\n\n`);
            resolve('reject');
          } else if (name === 'c' && event.ctrl) {
            cleanupKeys();
            resolve(null);
          } else if (name === 'escape') {
            cleanupKeys();
            resolve(null);
          }
        });

        render();
      }),
  );
}
