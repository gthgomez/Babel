import process from 'node:process';

import { alert } from '../../ui/dialog.js';
import { executeTask } from '../execution/dispatch.js';
import type { ReplContext } from '../context.js';

export async function executeReplTask(ctx: ReplContext, input: string): Promise<void> {
  try {
    return await executeTask(ctx, input);
  } catch (err: unknown) {
    ctx.isRunning = false;
    if (err && typeof err === 'object' && Symbol.for('babel.error.alerted') in err) return;
    const message = err instanceof Error ? err.message : String(err);
    if (process.stdout.isTTY && !process.env['CI']) {
      try {
        await alert({
          title: 'Execution Error',
          message: `A fatal error occurred during execution:\n\n${message}`,
        });
      } catch {
        console.error(`\nExecution Error: ${message}\n`);
      }
    } else {
      console.error(`\nExecution Error: ${message}\n`);
    }
  }
}