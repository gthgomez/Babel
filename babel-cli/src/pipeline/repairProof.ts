import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import type {
  AutonomousRepairProofAttemptEvidence,
  RepairProofFileHash,
} from '../services/autonomousRepairProofEvidence.js';
import {
  maxAttemptsForRepairMode,
  type FailureCapsule,
} from '../services/repairGovernance.js';
import type { ProjectSafetySnapshot } from '../services/terminalStatus.js';
import {
  isWithinProjectRootPath,
  resolveStepTargetPath,
} from '../stages/executorHelpers.js';


export const RELIABILITY_REPAIR_PROOF_MARKER = '[BABEL_RELIABILITY_AUTONOMOUS_LIVE_FAIL_THEN_PASS]';

export interface RepairProofCapsuleArtifact {
  id: string;
  path: string;
  capsule: FailureCapsule;
}

export function isReliabilityRepairProofEnabled(rawTask: string): boolean {
  return process.env['BABEL_RELIABILITY_REPAIR_PROOF'] === 'true' &&
    rawTask.includes(RELIABILITY_REPAIR_PROOF_MARKER);
}

export function getReliabilityRepairProofMaxFailures(): number {
  const configured = Number.parseInt(process.env['BABEL_RELIABILITY_REPAIR_PROOF_MAX_FAILURES'] ?? '', 10);
  if (!Number.isFinite(configured) || configured <= 0) {
    return maxAttemptsForRepairMode('autonomous');
  }
  return Math.min(configured, maxAttemptsForRepairMode('autonomous'));
}

export function hashProjectFileForEvidence(projectRoot: string | null | undefined, relativePath: string): string | null {
  if (!projectRoot || relativePath.trim().length === 0) {
    return null;
  }
  const resolved = resolveStepTargetPath(projectRoot, relativePath);
  if (!isWithinProjectRootPath(projectRoot, resolved) || !existsSync(resolved)) {
    return null;
  }
  try {
    return createHash('sha256').update(readFileSync(resolved)).digest('hex');
  } catch {
    return null;
  }
}

const SAFETY_SNAPSHOT_MAX_FILES = 2000;
const SAFETY_SNAPSHOT_IGNORED_DIRECTORIES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  'runs',
];

function hashAbsoluteFileForSafety(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

export function snapshotProjectFilesForSafety(projectRoot: string | null | undefined): ProjectSafetySnapshot {
  const root = projectRoot ? resolve(projectRoot) : null;
  const snapshot: ProjectSafetySnapshot = {
    root,
    files: {},
    file_count: 0,
    truncated: false,
    ignored_directories: SAFETY_SNAPSHOT_IGNORED_DIRECTORIES,
  };
  if (!root || !existsSync(root)) {
    return snapshot;
  }

  const ignored = new Set(SAFETY_SNAPSHOT_IGNORED_DIRECTORIES);
  const visit = (dir: string): void => {
    if (snapshot.truncated) {
      return;
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (snapshot.truncated) {
        return;
      }
      const absolute = join(dir, entry);
      let stat;
      try {
        stat = statSync(absolute);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!ignored.has(entry)) {
          visit(absolute);
        }
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      const relativePath = relative(root, absolute).replace(/\\/g, '/');
      snapshot.files[relativePath] = hashAbsoluteFileForSafety(absolute) ?? 'UNREADABLE';
      snapshot.file_count += 1;
      if (snapshot.file_count >= SAFETY_SNAPSHOT_MAX_FILES) {
        snapshot.truncated = true;
        return;
      }
    }
  };

  visit(root);
  return snapshot;
}

export function summarizeVerifierStreamForEvidence(text: string | null | undefined): string | null {
  const normalized = String(text ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(-12)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0
    ? normalized.slice(0, 700)
    : null;
}

export function hasMeaningfulRepairDiff(
  previous: AutonomousRepairProofAttemptEvidence | null,
  currentFileHashes: Record<string, RepairProofFileHash>,
): boolean | null {
  if (!previous) {
    return null;
  }
  const previousChanged = previous.changed_files.slice().sort();
  const currentChanged = Object.keys(currentFileHashes).sort();
  if (currentChanged.length === 0) {
    return false;
  }
  if (
    previousChanged.length !== currentChanged.length ||
    previousChanged.some((path, index) => path !== currentChanged[index])
  ) {
    return true;
  }
  return currentChanged.some(path =>
    previous.file_hashes[path]?.after !== currentFileHashes[path]?.after
  );
}
