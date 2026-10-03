/**
 * research/missionPlanner.ts — Mission construction and budget resolution
 *
 * Builds a ResearchMissionV1 from a problem statement and a target project
 * root. Deterministic: the same inputs produce the same mission except for
 * the timestamp/mission-id fields, which are supplied by the caller so
 * tests can pin them.
 *
 * The mission planner is trusted-side only: it sees the user's problem and
 * the local target project, never remote repository content.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUDGET_PRESET_VALUES,
  ResearchMissionV1Schema,
  type BudgetPresetName,
  type MissionBudget,
  type ResearchMissionV1,
} from './contracts.js';

export interface CreateMissionInput {
  problem: string;
  projectRoot: string;
  budgetPreset?: BudgetPresetName;
  now?: Date;
  missionId?: string;
}

/** Resolve the target project's HEAD SHA; null when not a git worktree. */
export function resolveTargetHeadSha(projectRoot: string): string | null {
  if (!existsSync(join(projectRoot, '.git'))) return null;
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Stable digest of the target project's repo-map inputs (placeholder digest over root metadata until RepoMap integration). */
export function computeRepoMapDigest(projectRoot: string): string | null {
  if (!existsSync(projectRoot)) return null;
  const hash = createHash('sha256');
  hash.update('repo-map-v1');
  hash.update(projectRoot);
  return hash.digest('hex');
}

export function resolveBudget(preset: BudgetPresetName): MissionBudget {
  return { ...BUDGET_PRESET_VALUES[preset] };
}

export function createResearchMission(input: CreateMissionInput): ResearchMissionV1 {
  const now = input.now ?? new Date();
  const headSha = resolveTargetHeadSha(input.projectRoot);
  const mission: ResearchMissionV1 = {
    schema_version: 1,
    mission_id: input.missionId ?? `mission_${now.toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`,
    mission_kind: 'solution_hunt',
    created_at: now.toISOString(),
    problem: {
      statement: input.problem,
      desired_outcome: '',
      failure_modes: [],
      constraints: [],
      non_goals: [],
    },
    target: {
      project_root: input.projectRoot,
      head_sha: headSha,
      repo_map_digest: computeRepoMapDigest(input.projectRoot),
    },
    budget: resolveBudget(input.budgetPreset ?? 'normal'),
    budget_preset: input.budgetPreset ?? 'normal',
    source_policy: {
      providers: ['github'],
      execute_foreign_code: false,
      allow_repository_mutation: false,
    },
  };
  return ResearchMissionV1Schema.parse(mission);
}
