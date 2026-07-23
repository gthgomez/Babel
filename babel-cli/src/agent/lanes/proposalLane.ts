import type { LiteResultPayload } from '../../cli/structuredOutput.js';
import {
  createLiteProviderAdapter,
  formatLitePatchText,
  runLitePatch,
} from '../../agent/provider/textProviderLane.js';
import {
  baseReadOnlyLitePayload,
  type AgentLaneContext,
  type ProposalSessionVerb,
} from '../contracts.js';
import { writeLiteJsonArtifact } from '../../lite/artifacts.js';
import { listArtifactPaths, resolveLiteRepoRoot } from '../liteArtifacts.js';

export interface ProposalLaneResult {
  payload: LiteResultPayload;
  humanText: string;
  exitCode: number;
}

export async function runProposalLane(
  context: AgentLaneContext,
  verb: ProposalSessionVerb,
): Promise<ProposalLaneResult> {
  const repoPath = resolveLiteRepoRoot(context.projectRoot);
  const adapter = createLiteProviderAdapter();
  const { textProviderId, offlineDemo } = adapter.resolve({
    ...(context.provider !== undefined ? { provider: context.provider } : {}),
  });
  const result = await runLitePatch({
    repoPath,
    task: context.task,
    provider: textProviderId,
    autoApply: false,
  });
  if (context.sparkSynthesis) {
    writeLiteJsonArtifact(
      {
        runId: result.artifacts.run_id,
        runDir: result.artifacts.run_dir,
        files: result.artifacts.files,
      },
      'spark_synthesis.json',
      context.sparkSynthesis,
    );
  }

  const base = baseReadOnlyLitePayload({
    command: verb,
    task: context.task,
    project: context.project ?? null,
    runDir: result.artifacts.run_dir,
    projectRoot: repoPath,
    status: 'PROPOSAL_READY',
    userStatus: 'success',
    selectedLane: 'lite_patch',
    executionPath: 'proposal_lane',
    next: [
      'Review proposal.diff; this lane never applies changes.',
      'Run babel "<task>" when you want Babel to apply a verified mutation.',
    ],
  });

  const payload: LiteResultPayload = {
    ...base,
    schema_retries: 0,
    recovered_after_schema_retry: false,
    ...(offlineDemo ? { execution_mode: 'offline_demo' as const } : {}),
    evidence: {
      run_dir: result.artifacts.run_dir,
      support_path: result.artifacts.run_dir,
      artifacts: listArtifactPaths({
        runId: result.artifacts.run_id,
        runDir: result.artifacts.run_dir,
        files: result.artifacts.files,
      }),
    },
    answer: {
      summary: 'Proposal-only diff generated.',
      facts: [],
      assumptions: [],
      read_only_steps: [],
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
    ...(context.sparkSynthesis ? { spark_synthesis: context.sparkSynthesis } : {}),
    ...(context.sparkReview
      ? {
          spark_agents: context.sparkReview.spark_agents,
          spark_run_dir: context.sparkReview.run_dir,
          spark_synthesis_path: context.sparkReview.synthesis_path,
        }
      : {}),
  } as LiteResultPayload;

  return {
    payload,
    humanText: formatLitePatchText(result),
    exitCode: 0,
  };
}
