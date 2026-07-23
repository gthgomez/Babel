import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { hasFinalEvidence } from '../evidence/runEvidence.js';
import { logDetail } from './logging.js';
import { BABEL_RUNS_DIR } from './paths.js';

export interface LatestRunPointerMetadata {
  status?: string;
  targetRoot?: string | null;
  command?: string;
  evidenceComplete?: boolean;
}

export function writeLatestRunPointers(
  runDir: string,
  project: string,
  metadata: LatestRunPointerMetadata = {},
): void {
  if (!hasFinalEvidence(runDir)) {
    logDetail(
      `[LATEST_RUN_WARNING] Skipping latest pointer write for incomplete evidence: ${runDir}`,
    );
    return;
  }

  const payload = {
    run_dir: runDir,
    project,
    created_at: new Date().toISOString(),
    ...(metadata.status ? { status: metadata.status } : {}),
    ...(metadata.targetRoot ? { target_root: metadata.targetRoot } : {}),
    ...(metadata.command ? { command: metadata.command } : {}),
    ...(metadata.evidenceComplete !== undefined
      ? { evidence_complete: metadata.evidenceComplete }
      : {}),
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
