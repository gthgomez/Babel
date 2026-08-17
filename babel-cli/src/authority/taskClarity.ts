/**
 * taskClarity.ts — task-intent / clarification layer (above the PDP).
 *
 * The PDP answers: "Is Babel authorized to perform this concrete action?"
 * This layer answers: "Is this concrete action actually what the user asked for?"
 *
 * Clarification is rare and must not expand the active lease.
 */

import type { CapabilityId } from './capabilities.js';
import { decideActionRequest, type PolicyDecision } from './pdp.js';
import type { AutonomyLease } from './lease.js';
import { normalizeEnvironment } from './targetBinding.js';

export type TaskClarityReason =
  | 'multiple_plausible_targets'
  | 'missing_required_target'
  | 'contradictory_instruction'
  | 'ambiguous_destructive_scope'
  | 'ambiguous_dirty_worktree_ownership'
  | 'ambiguous_environment';

export type TaskClarityDecision =
  | {
      outcome: 'clear';
      objective: string;
      resolvedTargets: string[];
    }
  | {
      outcome: 'needs_clarification';
      reason: TaskClarityReason;
      question: string;
      options?: string[];
    };

export interface TaskClarityCandidates {
  pullRequests?: string[];
  branches?: string[];
  environments?: string[];
}

export interface TaskClarityInput {
  task: string;
  candidates?: TaskClarityCandidates;
  intendedCapability?: CapabilityId;
}

export type HumanEscalationKind = 'autonomous' | 'autonomous_verify' | 'deny' | 'clarification';

export interface HumanEscalationResult {
  kind: HumanEscalationKind;
  clarity: TaskClarityDecision;
  reasonCode?: string;
}

const PRIVILEGED_MERGE = /\bmerge\b/i;
const PRIVILEGED_DEPLOY = /\bdeploy\b/i;
const PRIVILEGED_FORCE_PUSH = /\bforce[-\s]?push\b/i;
const PRIVILEGED_DELETE_BRANCHES = /\bdelete\b.*\b(old\s+)?(remote\s+)?branches\b/i;
const EXPOSE_SECRET = /\b(expose|print|show|dump)\b.*\b(api[-\s]?key|secret|credential|token)\b/i;
const PR_REF = /#(\d+)/g;
const NAMED_PR = /\bpr\s*#?\s*(\d+)\b/i;
const NAMED_BRANCH = /\bfeat\/[a-z0-9._/-]+|\bfix\/[a-z0-9._/-]+/i;
const NAMED_ENV = /\b(production|prod|staging|stage)\b/i;
const CODING_MERGE =
  /\bmerge\b.{0,80}\b(function|functions|helper|helpers|utility|utilities|module|modules|class|classes|file|files|import|imports|conflict|conflicts)\b/i;
const CODING_DEPLOY =
  /\bdeploy\b.{0,80}\b(fixture|fixtures|test|tests|local|mock|stub)\b/i;
const MERGE_IT = /\bmerge\s+it\b/i;
const DEPLOY_IT = /\bdeploy\s+it\b/i;
const PR_MERGE_SIGNAL = /\b(pr|pull request|#\d+)\b/i;
const CI_OR_TESTS = /\b(fix\s+(the\s+)?(failing\s+)?(ci|tests)|implement|refactor|choose the best)\b/i;
const COMMIT_PUSH = /\bcommit\b.*\bpush\b|\bpush\b.*\bfeature branch\b/i;

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => v.trim() !== ''))];
}

function isPrivilegedMergeTask(task: string, candidates?: TaskClarityCandidates): boolean {
  if (!PRIVILEGED_MERGE.test(task)) return false;
  if (CODING_MERGE.test(task) && !PR_MERGE_SIGNAL.test(task) && !MERGE_IT.test(task)) return false;
  if (PR_MERGE_SIGNAL.test(task) || MERGE_IT.test(task)) return true;
  return (candidates?.pullRequests?.length ?? 0) > 0;
}

function isPrivilegedDeployTask(task: string, candidates?: TaskClarityCandidates): boolean {
  if (!PRIVILEGED_DEPLOY.test(task)) return false;
  if (CODING_DEPLOY.test(task) && !NAMED_ENV.test(task) && !DEPLOY_IT.test(task)) return false;
  if (NAMED_ENV.test(task) || DEPLOY_IT.test(task)) return true;
  return (candidates?.environments?.length ?? 0) > 0;
}

function extractPrs(task: string, candidates?: TaskClarityCandidates): string[] {
  const fromTask: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(PR_REF.source, 'g');
  while ((match = re.exec(task)) !== null) {
    fromTask.push(`#${match[1]}`);
  }
  const named = NAMED_PR.exec(task);
  if (named?.[1]) fromTask.push(`#${named[1]}`);
  if (fromTask.length > 0) return unique(fromTask);
  return unique(candidates?.pullRequests ?? []);
}

/**
 * Assess whether the user task names a concrete, unambiguous objective.
 * Does not authorize anything — lease checks belong in the PDP.
 */
export function assessTaskClarity(input: TaskClarityInput): TaskClarityDecision {
  const task = input.task.trim();
  const objective = task;

  if (EXPOSE_SECRET.test(task)) {
    return { outcome: 'clear', objective, resolvedTargets: [] };
  }

  if (isPrivilegedMergeTask(task, input.candidates)) {
    const prs = extractPrs(task, input.candidates);
    if (prs.length === 1) {
      return { outcome: 'clear', objective, resolvedTargets: prs };
    }
    if (prs.length > 1) {
      return {
        outcome: 'needs_clarification',
        reason: 'multiple_plausible_targets',
        question: `Which PR should I merge: ${prs.join(' or ')}?`,
        options: prs,
      };
    }
    return {
      outcome: 'needs_clarification',
      reason: 'missing_required_target',
      question: 'Which pull request should I merge?',
    };
  }

  if (isPrivilegedDeployTask(task, input.candidates)) {
    const named = NAMED_ENV.exec(task);
    if (named?.[1]) {
      const env = named[1].toLowerCase() === 'prod' ? 'production' : named[1].toLowerCase();
      return { outcome: 'clear', objective, resolvedTargets: [env === 'stage' ? 'staging' : env] };
    }
    const envs = unique(input.candidates?.environments ?? []);
    if (envs.length === 1) {
      return { outcome: 'clear', objective, resolvedTargets: envs };
    }
    if (envs.length > 1) {
      return {
        outcome: 'needs_clarification',
        reason: 'ambiguous_environment',
        question: `Which environment should I deploy to: ${envs.join(' or ')}?`,
        options: envs,
      };
    }
    return {
      outcome: 'needs_clarification',
      reason: 'ambiguous_environment',
      question: 'Which environment should I deploy to?',
    };
  }

  if (PRIVILEGED_FORCE_PUSH.test(task)) {
    const named = NAMED_BRANCH.exec(task);
    if (named) {
      return { outcome: 'clear', objective, resolvedTargets: [named[0]] };
    }
    const branches = unique(input.candidates?.branches ?? []);
    if (branches.length === 1) {
      return { outcome: 'clear', objective, resolvedTargets: branches };
    }
    if (branches.length > 1) {
      return {
        outcome: 'needs_clarification',
        reason: 'multiple_plausible_targets',
        question: `Which branch should I force-push: ${branches.join(' or ')}?`,
        options: branches,
      };
    }
    return {
      outcome: 'needs_clarification',
      reason: 'missing_required_target',
      question: 'Which branch should I force-push?',
    };
  }

  if (PRIVILEGED_DELETE_BRANCHES.test(task)) {
    return {
      outcome: 'needs_clarification',
      reason: 'ambiguous_destructive_scope',
      question: 'Delete local branches, remote branches, or both — and which names?',
    };
  }

  return { outcome: 'clear', objective, resolvedTargets: [] };
}

export interface HumanEscalationInput {
  task: string;
  allowedCapabilities: readonly string[];
  candidates?: TaskClarityCandidates;
}

/**
 * Combine task clarity with lease membership for the frozen escalation matrix.
 * Clarification cannot grant a capability the lease omitted.
 */
export function resolveHumanEscalation(input: HumanEscalationInput): HumanEscalationResult {
  const task = input.task.trim();
  const allowed = new Set(input.allowedCapabilities);
  const clarity = assessTaskClarity({ task, ...(input.candidates ? { candidates: input.candidates } : {}) });

  if (EXPOSE_SECRET.test(task)) {
    return { kind: 'deny', clarity, reasonCode: 'DENY_CREDENTIAL_READ' };
  }

  if (isPrivilegedMergeTask(task, input.candidates)) {
    if (!allowed.has('merge')) {
      return { kind: 'deny', clarity, reasonCode: 'DENY_MISSING_AUTHORITY' };
    }
    if (clarity.outcome === 'needs_clarification') {
      return { kind: 'clarification', clarity };
    }
    return { kind: 'autonomous', clarity };
  }

  if (isPrivilegedDeployTask(task, input.candidates)) {
    if (!allowed.has('production_deploy')) {
      return { kind: 'deny', clarity, reasonCode: 'DENY_MISSING_AUTHORITY' };
    }
    if (clarity.outcome === 'needs_clarification') {
      return { kind: 'clarification', clarity };
    }
    return { kind: 'autonomous', clarity };
  }

  if (PRIVILEGED_FORCE_PUSH.test(task)) {
    if (!allowed.has('force_push')) {
      return { kind: 'deny', clarity, reasonCode: 'DENY_MISSING_AUTHORITY' };
    }
    if (clarity.outcome === 'needs_clarification') {
      return { kind: 'clarification', clarity };
    }
    return { kind: 'autonomous_verify', clarity };
  }

  if (PRIVILEGED_DELETE_BRANCHES.test(task)) {
    if (!allowed.has('destructive_data_delete')) {
      return { kind: 'deny', clarity, reasonCode: 'DENY_MISSING_AUTHORITY' };
    }
    if (clarity.outcome === 'needs_clarification') {
      return { kind: 'clarification', clarity };
    }
    return { kind: 'autonomous', clarity };
  }

  if (COMMIT_PUSH.test(task)) {
    if (!allowed.has('push_feature_branch') && !allowed.has('commit_ship_set')) {
      return { kind: 'deny', clarity, reasonCode: 'DENY_MISSING_AUTHORITY' };
    }
    return { kind: 'autonomous_verify', clarity };
  }

  if (CI_OR_TESTS.test(task) || clarity.outcome === 'clear') {
    return { kind: 'autonomous', clarity };
  }

  return { kind: 'autonomous', clarity };
}

/** Candidates already inside the lease — clarification may only choose among these. */
export function candidatesFromLease(lease: AutonomyLease): TaskClarityCandidates {
  return {
    pullRequests: lease.constraints.allowedPullRequests.map((n) => `#${n}`),
    branches: [...lease.constraints.allowedForcePushBranches],
    environments: [...lease.constraints.allowedEnvironments],
  };
}

/**
 * Apply a clarification answer against the existing lease. Cannot add
 * capabilities or widen target scope.
 */
export function applyClarificationResponse(input: {
  lease: AutonomyLease;
  intendedCapability: CapabilityId;
  chosenTarget: string;
  now?: Date | number;
}): PolicyDecision {
  const capability = input.intendedCapability;
  if (capability === 'merge' || capability === 'pr_mark_ready') {
    return decideActionRequest(
      { capability, target: input.chosenTarget },
      input.lease,
      input.now,
    );
  }
  if (capability === 'force_push') {
    return decideActionRequest(
      { capability, destinationBranch: input.chosenTarget, force: true },
      input.lease,
      input.now,
    );
  }
  if (capability === 'production_deploy') {
    return decideActionRequest(
      { capability, environment: normalizeEnvironment(input.chosenTarget) },
      input.lease,
      input.now,
    );
  }
  return decideActionRequest(
    { capability, target: input.chosenTarget },
    input.lease,
    input.now,
  );
}

export interface SessionTaskGateInput {
  task: string;
  lease: AutonomyLease | null;
  candidates?: TaskClarityCandidates;
  pending?: { capability: CapabilityId; options?: string[] };
}

/**
 * Session-level task gate used by ChatEngine. Clarification cannot mint
 * authority; a pending answer is checked against the existing lease only.
 */
export function evaluateSessionTaskGate(input: SessionTaskGateInput): HumanEscalationResult {
  if (!input.lease) {
    const clarity = assessTaskClarity({
      task: input.task,
      ...(input.candidates ? { candidates: input.candidates } : {}),
    });
    return { kind: 'autonomous', clarity };
  }
  const allowed = input.lease.allowedCapabilities;
  const leaseCandidates = candidatesFromLease(input.lease);
  const pullRequests = input.candidates?.pullRequests ?? leaseCandidates.pullRequests;
  const branches = input.candidates?.branches ?? leaseCandidates.branches;
  const environments = input.candidates?.environments ?? leaseCandidates.environments;
  const candidates: TaskClarityCandidates = {
    ...(pullRequests ? { pullRequests } : {}),
    ...(branches ? { branches } : {}),
    ...(environments ? { environments } : {}),
  };

  if (input.pending && input.lease) {
    const decision = applyClarificationResponse({
      lease: input.lease,
      intendedCapability: input.pending.capability,
      chosenTarget: input.task.trim(),
    });
    const clarity: TaskClarityDecision = {
      outcome: 'clear',
      objective: input.task,
      resolvedTargets: [input.task.trim()],
    };
    if (decision.outcome === 'deny') {
      return { kind: 'deny', clarity, reasonCode: decision.reasonCode };
    }
    return {
      kind: decision.outcome === 'verify' ? 'autonomous_verify' : 'autonomous',
      clarity,
      reasonCode: decision.reasonCode,
    };
  }

  return resolveHumanEscalation({
    task: input.task,
    allowedCapabilities: allowed,
    candidates,
  });
}
