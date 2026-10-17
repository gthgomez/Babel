import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describePreambleBudget, type enforcePreambleBudget } from './preambleBudget.js';

/** Content-free numeric diagnostics belong to the run bundle, never the TUI. */
export function persistPreambleBudget(runDir: string, budget: ReturnType<typeof enforcePreambleBudget>): boolean {
  try {
    writeFileSync(join(runDir, 'preamble-budget.json'), JSON.stringify(describePreambleBudget(budget), null, 2) + '\n');
    return true;
  } catch {
    return false; // Optional telemetry must not fail a response or write over its cells.
  }
}
