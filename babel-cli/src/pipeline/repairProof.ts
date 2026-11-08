
import type {
  AutonomousRepairProofAttemptEvidence,
  RepairProofFileHash,
} from '../services/autonomousRepairProofEvidence.js';
import { maxAttemptsForRepairMode, type FailureCapsule } from '../services/repairGovernance.js';
export { hashProjectFileForEvidence, snapshotProjectFilesForSafety } from '../stages/executorHelpers.js';

export const RELIABILITY_REPAIR_PROOF_MARKER = '[BABEL_RELIABILITY_AUTONOMOUS_LIVE_FAIL_THEN_PASS]';

export interface RepairProofCapsuleArtifact {
  id: string;
  path: string;
  capsule: FailureCapsule;
}

export function isReliabilityRepairProofEnabled(rawTask: string): boolean {
  return (
    process.env['BABEL_RELIABILITY_REPAIR_PROOF'] === 'true' &&
    rawTask.includes(RELIABILITY_REPAIR_PROOF_MARKER)
  );
}

export function getReliabilityRepairProofMaxFailures(): number {
  const configured = Number.parseInt(
    process.env['BABEL_RELIABILITY_REPAIR_PROOF_MAX_FAILURES'] ?? '',
    10,
  );
  if (!Number.isFinite(configured) || configured <= 0) {
    return maxAttemptsForRepairMode('deep');
  }
  return Math.min(configured, maxAttemptsForRepairMode('deep'));
}

export function summarizeVerifierStreamForEvidence(text: string | null | undefined): string | null {
  const normalized = String(text ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-12)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized.slice(0, 700) : null;
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
  return currentChanged.some(
    (path) => previous.file_hashes[path]?.after !== currentFileHashes[path]?.after,
  );
}
