import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runWithPrimaryOnlyFallback } from '../../execute.js';
import { LitePlanReviewSchema, type LitePlanReview } from '../../schemas/liteReadOnlyAnswers.js';
import {
  writeLiteJsonArtifact,
  writeLiteTextArtifact,
  type LiteArtifactRun,
} from '../../lite/artifacts.js';
import { resolveLiteRepoRoot } from '../liteArtifacts.js';

export interface PlanReviewLaneContext {
  task: string;
  planRunDir: string;
  projectRoot?: string;
  provider?: string;
}

export interface PlanReviewLaneResult {
  review: LitePlanReview;
  reviewPath: string;
  humanText: string;
}

function readArtifactText(planRunDir: string, name: string): string {
  const path = join(planRunDir, name);
  if (!existsSync(path)) {
    return '';
  }
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function buildLocalMockReview(planText: string, task: string): LitePlanReview {
  const hasRisk = /\b(migration|repo[- ]wide|security|breaking)\b/i.test(`${task}\n${planText}`);
  return {
    schema_version: 1,
    verdict: hasRisk ? 'REVISE' : 'APPROVE',
    summary: hasRisk
      ? 'The plan is directionally sound but needs tighter scope before implementation.'
      : 'The plan is concrete enough to review with the user before implementation.',
    findings: hasRisk
      ? ['Scope signals suggest narrowing file targets and verification steps before apply.']
      : ['Plan names concrete steps and verification expectations.'],
    risks: hasRisk ? ['Repo-wide or high-risk wording detected in the task or plan.'] : [],
    suggested_changes: hasRisk ? ['Name explicit files and verifiers before approving apply.'] : [],
  };
}

function buildReviewPrompt(input: {
  task: string;
  planRunDir: string;
  planText: string;
  modelPlanJson: string;
}): string {
  return [
    '# Babel Plan Review',
    '',
    'You are a separate read-only reviewer agent. Audit the plan below for safety, scope, and executability.',
    'Do not modify files. Return one JSON object exactly matching this shape:',
    '{"schema_version":1,"verdict":"APPROVE|REVISE|REJECT","summary":"one sentence","findings":[],"risks":[],"suggested_changes":[]}',
    '',
    'Rules:',
    '- APPROVE when the plan is bounded, names real files, and has verification.',
    '- REVISE when the plan is plausible but missing scope, file targets, or verification detail.',
    '- REJECT when the plan is unsafe, hallucinated, or too broad for a bounded apply.',
    '',
    `Task: ${input.task}`,
    `Plan run: ${input.planRunDir}`,
    '',
    '# Plan text',
    input.planText || '(missing plan.md)',
    '',
    '# Plan JSON',
    input.modelPlanJson || '(missing model_plan.json)',
  ].join('\n');
}

export function formatPlanReviewHuman(review: LitePlanReview): string {
  const lines = ['', 'Plan review:', `Verdict: ${review.verdict}`, review.summary];
  if (review.findings.length > 0) {
    lines.push('', 'Findings:');
    for (const finding of review.findings.slice(0, 6)) {
      lines.push(`- ${finding}`);
    }
  }
  if (review.risks.length > 0) {
    lines.push('', 'Risks:');
    for (const risk of review.risks.slice(0, 6)) {
      lines.push(`- ${risk}`);
    }
  }
  if (review.suggested_changes.length > 0) {
    lines.push('', 'Suggested changes:');
    for (const change of review.suggested_changes.slice(0, 6)) {
      lines.push(`- ${change}`);
    }
  }
  if (review.verdict !== 'APPROVE') {
    lines.push('', 'You can still approve and apply this plan, but review the findings first.');
  }
  return lines.join('\n');
}

export async function runPlanReviewLane(
  context: PlanReviewLaneContext,
): Promise<PlanReviewLaneResult> {
  const repoPath = resolveLiteRepoRoot(context.projectRoot);
  const planRunDir = context.planRunDir;
  const planText =
    readArtifactText(planRunDir, 'plan.md') || readArtifactText(planRunDir, 'response.md');
  const modelPlanJson = readArtifactText(planRunDir, 'model_plan.json');
  const useLocalMock = context.provider === 'mock' || process.env['BABEL_LITE_OFFLINE'] === '1';
  const review = useLocalMock
    ? buildLocalMockReview(planText, context.task)
    : await runWithPrimaryOnlyFallback(
        buildReviewPrompt({ task: context.task, planRunDir, planText, modelPlanJson }),
        LitePlanReviewSchema,
        {
          stage: 'planning',
          schemaName: 'LitePlanReviewSchema',
          maxCliAttempts: 2,
        },
      );
  const artifactRun: LiteArtifactRun = {
    runId: planRunDir.split(/[/\\]/).pop() ?? 'plan',
    runDir: planRunDir,
    files: {},
  };
  const reviewPath = writeLiteJsonArtifact(artifactRun, 'plan_review.json', review);
  writeLiteTextArtifact(artifactRun, 'plan_review.md', formatPlanReviewHuman(review));

  return {
    review,
    reviewPath,
    humanText: formatPlanReviewHuman(review),
  };
}
