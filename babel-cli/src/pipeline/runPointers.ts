import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { logDetail } from './logging.js';
import { BABEL_RUNS_DIR } from './paths.js';

export function writeLatestRunPointers(runDir: string, project: string): void {
  const payload = {
    run_dir: runDir,
    project,
    created_at: new Date().toISOString(),
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const safeProject = project.replace(/[^a-zA-Z0-9_-]/g, '_');

  try {
    writeFileSync(join(BABEL_RUNS_DIR, '.latest.json'), serialized, 'utf-8');
    writeFileSync(join(BABEL_RUNS_DIR, `.latest.${safeProject}.json`), serialized, 'utf-8');
  } catch (err) {
    logDetail(
      `[LATEST_RUN_WARNING] Failed to write latest pointers: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
