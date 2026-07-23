import { join, resolve } from 'node:path';

import type { LiteResultPayload } from '../../cli/structuredOutput.js';
import { formatCiReviewHuman, runCiReview } from '../../services/ciReview.js';
import { runLaneVerifiers } from '../../stages/verifierContract.js';
import { baseReadOnlyLitePayload, type AgentLaneContext } from '../contracts.js';
import {
  beginLiteArtifactRun,
  listArtifactPaths,
  resolveLiteRepoRoot,
  writeLiteManifest,
  writeLiteRequest,
} from '../liteArtifacts.js';
import { writeLiteJsonArtifact, writeLiteTextArtifact } from '../../lite/artifacts.js';

export interface ReviewLaneResult {
  payload: LiteResultPayload;
  humanText: string;
  exitCode: number;
}

export async function runReviewLane(context: AgentLaneContext): Promise<ReviewLaneResult> {
  const repoPath = resolveLiteRepoRoot(context.projectRoot);
  const report = runCiReview({
    projectRoot: repoPath,
    outputDir: join(repoPath, 'runs', 'babel-lite'),
  });
  const artifacts = beginLiteArtifactRun({ command: 'review', repoPath });

  writeLiteRequest(artifacts, {
    schema_version: 1,
    command: 'review',
    task: context.task,
    project_root: repoPath,
  });
  writeLiteManifest(artifacts, {
    schema_version: 1,
    command: 'review',
    status: 'REVIEW_READY',
    run_id: artifacts.runId,
    mutation_policy: 'read_only',
  });
  // ── Lane Verifiers (P1.3) ──────────────────────────────────────────────────
  const verifierReport = await runLaneVerifiers({
    runDir: artifacts.runDir,
    task: context.task,
    verb: 'review',
    projectRoot: repoPath,
  });
  writeLiteJsonArtifact(artifacts, 'verification.json', {
    status: verifierReport.overallStatus === 'fail' ? 'attention' : 'not_required',
    reason: 'read-only review lane',
    verifier_report: verifierReport,
  });
  writeLiteTextArtifact(artifacts, 'response.md', formatCiReviewHuman(report));

  const inspectedFiles = report.changed_files.map((file) => file.path);
  const base = baseReadOnlyLitePayload({
    command: 'review',
    task: context.task || 'Review current diff',
    project: context.project ?? null,
    runDir: artifacts.runDir,
    projectRoot: repoPath,
    status: 'REVIEW_READY',
    userStatus: report.status === 'pass' ? 'success' : 'partial',
    selectedLane: 'lite_review',
    executionPath: 'review_lane',
    next: [
      'Address high-risk findings before merging.',
      'Run babel "<task>" for narrow verified edits.',
    ],
  });

  const payload: LiteResultPayload = {
    ...base,
    schema_retries: 0,
    recovered_after_schema_retry: false,
    scope: {
      project_root: repoPath,
      allowed_write_paths: [],
      refused_paths: [],
    },
    changed_files: inspectedFiles,
    evidence: {
      run_dir: artifacts.runDir,
      support_path: artifacts.runDir,
      artifacts: [...listArtifactPaths(artifacts), report.artifact_path],
    },
    answer: {
      summary: report.summary.recommended_next_action,
      facts: report.changed_files.map((file) => `${file.path} (${file.status})`),
      assumptions: report.risks.map((risk) => risk.message),
      read_only_steps: ['Reviewed working tree diff without mutation.'],
    },
    ...(context.routeDecision
      ? {
          route_reason: context.routeDecision.route_reason,
          complexity: context.routeDecision.complexity,
          risk_signals: context.routeDecision.risk_signals,
          model_tier_recommendation: context.routeDecision.model_tier_recommendation,
          full_babel_equivalent: context.routeDecision.full_babel_equivalent,
        }
      : {}),
  } as LiteResultPayload;

  return {
    payload,
    humanText: formatCiReviewHuman(report),
    exitCode: report.status === 'pass' ? 0 : 0,
  };
}
