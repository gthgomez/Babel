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

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runGitCommand } from '../utils/gitExec.js';
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
    const result = runGitCommand(['rev-parse', 'HEAD'], projectRoot, { timeoutMs: 3000 });
    if (result.status !== 0) return null;
    const sha = result.stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** No repository-content digest is available until authoritative RepoMap integration. */
export function computeRepoMapDigest(_projectRoot: string): string | null {
  return null;
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
