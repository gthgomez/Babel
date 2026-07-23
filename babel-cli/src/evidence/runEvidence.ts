import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface LatestPointerRepairReport {
  repaired: string[];
  removed: string[];
  skipped: string[];
}

export function hasFinalEvidence(runDir: string): boolean {
  return (
    existsSync(join(runDir, 'terminal_status_summary.json')) ||
    existsSync(join(runDir, '04_execution_report.json')) ||
    existsSync(join(runDir, 'manifest.json'))
  );
}

export function listLatestPointerFiles(runsDir: string): string[] {
  if (!existsSync(runsDir)) {
    return [];
  }
  return readdirSync(runsDir)
    .filter((name) => /^\.latest(?:\.[^.]+)?\.json$/.test(name))
    .map((name) => join(runsDir, name));
}

function safeParseJsonFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function isStaleLatestPointer(
  parsed: Record<string, unknown> | null,
  runDir: string | null,
): boolean {
  if (!runDir) {
    return false;
  }
  if (!existsSync(runDir)) {
    return true;
  }
  if (parsed !== null && parsed['evidence_complete'] === false) {
    return true;
  }
  return !hasFinalEvidence(runDir);
}

export function repairStaleLatestPointers(runsDir: string): LatestPointerRepairReport {
  const report: LatestPointerRepairReport = {
    repaired: [],
    removed: [],
    skipped: [],
  };

  for (const pointerPath of listLatestPointerFiles(runsDir)) {
    const parsed = safeParseJsonFile(pointerPath);
    const runDir = typeof parsed?.['run_dir'] === 'string' ? parsed['run_dir'] : null;
    if (!runDir) {
      report.skipped.push(pointerPath);
      continue;
    }
    if (!isStaleLatestPointer(parsed, runDir)) {
      report.skipped.push(pointerPath);
      continue;
    }
    try {
      rmSync(pointerPath, { force: true });
      report.removed.push(pointerPath);
      report.repaired.push(pointerPath);
    } catch {
      report.skipped.push(pointerPath);
    }
  }

  return report;
}
