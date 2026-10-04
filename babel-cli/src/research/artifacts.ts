/**
 * research/artifacts.ts — Deterministic research run artifact writer
 *
 * Persists Repo Hunt run artifacts under the standard Babel runs root
 * (BABEL_RUNS_DIR), following the atomic tmp+rename convention used by
 * EvidenceBundle. Layout per mission:
 *
 *   <runs>/<mission_slug>/research/
 *     mission.json
 *     query-plan.json
 *     discovery/candidates.jsonl
 *     discovery/score-breakdown.jsonl
 *     snapshots/manifests.jsonl
 *     evidence/evidence.jsonl
 *     evidence/validation.jsonl
 *     patterns/patterns.jsonl
 *     report/metrics.json
 *
 * Writes are idempotent: appending the same record twice is a caller
 * error for JSONL (records carry their own ids); whole-file writes are
 * last-write-wins with atomic rename.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { BABEL_RUNS_DIR, sanitizePathComponent } from '../cli/constants.js';
import type { ResearchMissionV1 } from './contracts.js';

export interface ResearchRunPaths {
  runDir: string;
  researchDir: string;
  missionJson: string;
  queryPlanJson: string;
  candidatesJsonl: string;
  scoreBreakdownJsonl: string;
  snapshotManifestsJsonl: string;
  evidenceJsonl: string;
  evidenceValidationJsonl: string;
  patternsJsonl: string;
  metricsJson: string;
}

/** Atomic whole-file JSON write (tmp + rename), pretty-printed with stable key order as authored. */
export function writeJsonArtifact(filePath: string, value: unknown): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, filePath);
}

/** Append one JSON line; caller must not append duplicate records with the same id field. */
export function appendJsonl(filePath: string, record: unknown): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  const fd = openSync(filePath, 'a');
  try {
    writeSync(fd, JSON.stringify(record) + '\n');
  } finally {
    closeSync(fd);
  }
}

export function readJsonl<T>(filePath: string): T[] {
  // Used by inspection/reporting; tolerant of a missing file (no records yet).
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function missionRunDirName(mission: ResearchMissionV1): string {
  const stamp = mission.created_at.replace(/[:.]/g, '-');
  return sanitizePathComponent(`${stamp}_${mission.mission_id}`);
}

export function researchRunPaths(runsRoot: string, mission: ResearchMissionV1): ResearchRunPaths {
  const runDir = join(runsRoot, missionRunDirName(mission));
  const researchDir = join(runDir, 'research');
  return {
    runDir,
    researchDir,
    missionJson: join(researchDir, 'mission.json'),
    queryPlanJson: join(researchDir, 'query-plan.json'),
    candidatesJsonl: join(researchDir, 'discovery', 'candidates.jsonl'),
    scoreBreakdownJsonl: join(researchDir, 'discovery', 'score-breakdown.jsonl'),
    snapshotManifestsJsonl: join(researchDir, 'snapshots', 'manifests.jsonl'),
    evidenceJsonl: join(researchDir, 'evidence', 'evidence.jsonl'),
    evidenceValidationJsonl: join(researchDir, 'evidence', 'validation.jsonl'),
    patternsJsonl: join(researchDir, 'patterns', 'patterns.jsonl'),
    metricsJson: join(researchDir, 'report', 'metrics.json'),
  };
}

/** Create the run directory tree and persist the mission artifact. */
export function initializeResearchRun(
  mission: ResearchMissionV1,
  runsRoot: string = BABEL_RUNS_DIR,
): ResearchRunPaths {
  const paths = researchRunPaths(runsRoot, mission);
  mkdirSync(paths.researchDir, { recursive: true });
  writeJsonArtifact(paths.missionJson, mission);
  return paths;
}
