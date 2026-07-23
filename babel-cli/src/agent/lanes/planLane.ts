import { join, resolve } from 'node:path';

import {
  formatLiteResultHuman,
  getSchemaRetrySummary,
  type LiteResultPayload,
} from '../../cli/structuredOutput.js';
import { formatLiteContractText } from '../../lite/contract.js';
import { runLitePlan } from '../../agent/provider/textProviderLane.js';
import { runWithPrimaryOnlyFallback } from '../../execute.js';
import { baseReadOnlyLitePayload, type AgentLaneContext } from '../contracts.js';
import {
  beginLiteEvidenceSession,
  listArtifactPaths,
  resolveLiteRepoRoot,
  writeLiteManifest,
  writeLiteRequest,
} from '../liteArtifacts.js';
import { writeLiteJsonArtifact, writeLiteTextArtifact } from '../../lite/artifacts.js';
import { buildCostLedger, usageSummaryFromCostLedger } from '../../services/costLedger.js';
import { readLiteProjectContext } from '../../services/liteProjectContext.js';
import {
  consumeLiteSchemaNormalizations,
  LitePlanAnswerSchema,
  type LitePlanAnswer,
} from '../../schemas/liteReadOnlyAnswers.js';
import { recordSchemaNormalizationHints } from '../../services/schemaFailureLedger.js';
import {
  buildReadOnlyToolContext,
  mergeDiscoveryAndSynthesisSessionSteps,
  runReadOnlyAgentLoop,
} from './readOnlyAgentLoop.js';
import { runPlanReviewLane, formatPlanReviewHuman } from './planReviewLane.js';
import { runLaneVerifiers } from '../../stages/verifierContract.js';

export interface PlanLaneResult {
  payload: LiteResultPayload;
  humanText: string;
  exitCode: number;
}

function buildModelPlanPrompt(input: {
  task: string;
  repoPath: string;
  contractText: string;
  projectContext: string;
}): string {
  return [
    '# Babel Lite Plan',
    '',
    'Create a read-only implementation plan for the user. Do not claim files were changed.',
    'Return one JSON object exactly matching this shape:',
    '{"schema_version":1,"status":"PLAN_READY","summary":"one sentence","answer":"plain user-facing plan summary","steps":[],"likely_files":[],"risks":[],"verification":[],"next":[]}',
    '',
    'Rules:',
    '- Use relative file paths from the contract when naming files.',
    '- Keep steps concrete enough for a coding agent to execute.',
    '- Required reads in Available Context are already provided; do not request file contents unless a path is marked missing or unreadable.',
    '- If the context is insufficient, use status NEEDS_MORE_CONTEXT and explain what is missing.',
    '',
    `Task: ${input.task}`,
    `Target: ${input.repoPath}`,
    '',
    '# Available Context',
    input.projectContext,
    '',
    '# Deterministic Repo Contract',
    input.contractText,
  ].join('\n');
}

function formatModelPlanText(answer: LitePlanAnswer): string {
  const lines = [
    answer.answer || answer.summary,
    '',
    'Steps:',
    ...(answer.steps.length > 0
      ? answer.steps.map((step, index) => `${index + 1}. ${step}`)
      : ['1. Review the task and target files.']),
  ];
  if (answer.likely_files.length > 0) {
    lines.push('', 'Likely files:', ...answer.likely_files.map((file) => `- ${file}`));
  }
  if (answer.risks.length > 0) {
    lines.push('', 'Risks:', ...answer.risks.map((risk) => `- ${risk}`));
  }
  if (answer.verification.length > 0) {
    lines.push('', 'Verification:', ...answer.verification.map((check) => `- ${check}`));
  }
  return lines.join('\n');
}

function buildLocalMockPlanAnswer(
  context: AgentLaneContext,
  plan: ReturnType<typeof runLitePlan>,
): LitePlanAnswer {
  const likelyFiles = plan.contract.likely_files.slice(0, 5);
  const requiredReads = plan.contract.required_reads.slice(0, 5);
  return {
    schema_version: 1,
    status: 'PLAN_READY',
    summary: `Prepared a local read-only plan for ${context.task}.`,
    answer: `Prepared a local read-only plan. Start by reading ${requiredReads[0] ?? 'the target files'}, then apply the smallest safe change path if you choose to run a fix.`,
    steps: [
      ...requiredReads.map((read) => `Inspect ${read}.`),
      'Decide whether to propose a patch or run a targeted fix.',
      'Run the verifier before considering the work complete.',
    ].slice(0, 6),
    likely_files: likelyFiles,
    risks: plan.contract.warnings,
    verification: plan.contract.verification_candidates,
    next: [
      'Review plan.md in the artifact directory.',
      'Run babel plan or babel "<task>" when you are ready to continue.',
    ],
  };
}

export async function runPlanLane(context: AgentLaneContext): Promise<PlanLaneResult> {
  const repoPath = resolveLiteRepoRoot(context.projectRoot);
  const plan = runLitePlan({ repoPath, task: context.task });
  const { run: artifacts, evidence } = beginLiteEvidenceSession({ command: 'plan', repoPath });
  const planText = formatLiteContractText(plan.contract);
  const projectContext = await readLiteProjectContext({
    projectRoot: repoPath,
    task: context.task,
    requiredReads: plan.contract.required_reads,
  });
  const useLocalMockPlan = context.provider === 'mock' || process.env['BABEL_LITE_OFFLINE'] === '1';
  const discovery = await runReadOnlyAgentLoop({
    verb: 'plan',
    task: context.task,
    projectRoot: repoPath,
    seedPaths: plan.contract.required_reads,
    toolContext: buildReadOnlyToolContext({
      verb: 'plan',
      runId: evidence.runId,
      runDir: evidence.runDir,
    }),
    evidence,
    ...(context.provider === 'mock' || context.provider === 'live'
      ? { provider: context.provider }
      : {}),
    useDeterministicMock: useLocalMockPlan,
    ...(context.toolStream !== undefined ? { toolStream: context.toolStream } : {}),
  });
  evidence.writeDebugFile(
    'plan_session_loop.json',
    `${JSON.stringify(
      {
        schema_version: 1,
        degraded: discovery.degraded,
        steps: discovery.sessionLoopSteps,
        tool_call_log: discovery.toolCallLog,
      },
      null,
      2,
    )}\n`,
  );
  const prompt = buildModelPlanPrompt({
    task: context.task,
    repoPath,
    contractText: planText,
    projectContext: [
      projectContext,
      '',
      '# Runtime Tool Observations',
      discovery.observations,
    ].join('\n'),
  });

  writeLiteRequest(artifacts, {
    schema_version: 1,
    command: 'plan',
    task: context.task,
    project: context.project ?? null,
    project_root: repoPath,
  });
  evidence.writeCompiledContext('lite_plan', prompt);
  const modelPlan = useLocalMockPlan
    ? buildLocalMockPlanAnswer(context, plan)
    : await runWithPrimaryOnlyFallback(prompt, LitePlanAnswerSchema, {
        evidence,
        stage: 'planning',
        schemaName: 'LitePlanAnswerSchema',
        maxCliAttempts: 2,
      });
  const schemaNormalizations = consumeLiteSchemaNormalizations();
  if (schemaNormalizations.length > 0) {
    writeLiteJsonArtifact(artifacts, 'lite_schema_normalization.json', {
      schema_version: 1,
      normalizations: schemaNormalizations,
    });
    recordSchemaNormalizationHints(evidence, {
      stage: 'planning',
      schemaName: 'LitePlanAnswerSchema',
      normalizations: schemaNormalizations,
    });
  }
  const modelPlanText = formatModelPlanText(modelPlan);
  evidence.writeDebugFile('lite_plan_answer.json', `${JSON.stringify(modelPlan, null, 2)}\n`);
  evidence.writeExecutionLog({
    status: modelPlan.status,
    stage_status: 'PLAN_COMPLETE',
    steps_executed: discovery.stepsExecuted,
    tool_call_log: discovery.toolCallLog,
    answer_path: join(evidence.runDir, 'lite_plan_answer.json'),
  });
  evidence.writeWaterfallTelemetry();
  const costLedger = buildCostLedger({
    runId: evidence.runId,
    task: context.task,
    lane: 'plan',
    waterfallEntries: evidence.getWaterfallLogSnapshot(),
  });
  evidence.writeCostLedger(costLedger);
  artifacts.files['cost_ledger.json'] = join(artifacts.runDir, 'cost_ledger.json');
  writeLiteManifest(artifacts, {
    schema_version: 1,
    command: 'plan',
    status: modelPlan.status,
    run_id: artifacts.runId,
    task: context.task,
    project_root: repoPath,
    mutation_policy: 'read_only',
  });
  writeLiteTextArtifact(artifacts, 'plan.md', modelPlanText);
  writeLiteTextArtifact(artifacts, 'response.md', modelPlanText);
  writeLiteJsonArtifact(artifacts, 'model_plan.json', modelPlan);
  // ── Lane Verifiers (P1.3) ──────────────────────────────────────────────────
  const verifierReport = await runLaneVerifiers({
    runDir: artifacts.runDir,
    task: context.task,
    verb: 'plan',
    projectRoot: repoPath,
  });
  writeLiteJsonArtifact(artifacts, 'verification.json', {
    status: verifierReport.overallStatus === 'fail' ? 'attention' : 'not_required',
    reason: 'read-only plan lane',
    verifier_report: verifierReport,
  });
  if (context.sparkSynthesis) {
    writeLiteJsonArtifact(artifacts, 'spark_synthesis.json', context.sparkSynthesis);
  }

  // ── Plan Review Subagent (P1.1) ──────────────────────────────────────────────
  let planReview: Awaited<ReturnType<typeof runPlanReviewLane>> | null = null;
  if (context.planReview) {
    try {
      planReview = await runPlanReviewLane({
        task: context.task,
        planRunDir: artifacts.runDir,
        projectRoot: repoPath,
        ...(context.provider !== undefined ? { provider: context.provider } : {}),
      });
      writeLiteJsonArtifact(artifacts, 'plan_review.json', planReview.review);
      writeLiteTextArtifact(artifacts, 'plan_review.md', formatPlanReviewHuman(planReview.review));
    } catch (err: any) {
      // Plan review is advisory — failures must not block the plan lane.
      evidence.writeDebugFile('plan_review_error.txt', err?.message ?? 'Unknown plan review error');
    }
  }

  const actStatus: 'pass' | 'fail' | 'blocked' =
    modelPlan.status === 'PLAN_READY'
      ? 'pass'
      : modelPlan.status === 'NEEDS_MORE_CONTEXT'
        ? 'blocked'
        : 'fail';
  const sessionLoopSteps = mergeDiscoveryAndSynthesisSessionSteps({
    discoverySteps: discovery.sessionLoopSteps,
    act: actStatus,
    verify: 'pass',
    terminal: modelPlan.status === 'PLAN_READY' ? 'finish' : 'blocked',
  });

  const schemaRetry = getSchemaRetrySummary(artifacts.runDir);
  const base = baseReadOnlyLitePayload({
    command: 'plan',
    task: context.task,
    project: context.project ?? null,
    runDir: artifacts.runDir,
    projectRoot: repoPath,
    status: modelPlan.status,
    userStatus: modelPlan.status === 'PLAN_READY' ? 'success' : 'blocked',
    selectedLane: 'lite_plan',
    executionPath: 'session_loop',
    next: [
      typeof modelPlan.next[0] === 'string'
        ? modelPlan.next[0]
        : 'Review plan.md in the artifact directory.',
      typeof modelPlan.next[1] === 'string'
        ? modelPlan.next[1]
        : 'Run babel plan or babel "<task>" when you are ready to continue.',
    ],
  });

  const usageSummary = usageSummaryFromCostLedger(costLedger);
  const payload: LiteResultPayload = {
    ...base,
    ...schemaRetry,
    session_loop_steps: sessionLoopSteps,
    evidence: {
      run_dir: artifacts.runDir,
      support_path: artifacts.runDir,
      artifacts: listArtifactPaths(artifacts),
    },
    usage: {
      ...usageSummary,
      cost_ledger_path: join(artifacts.runDir, 'cost_ledger.json'),
    },
    answer: {
      summary: modelPlan.summary,
      answer: modelPlan.answer,
      facts:
        modelPlan.likely_files.length > 0 ? modelPlan.likely_files : plan.contract.likely_files,
      assumptions: modelPlan.risks.length > 0 ? modelPlan.risks : plan.contract.warnings,
      read_only_steps: plan.contract.required_reads,
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

  // Attach plan review to payload when present
  if (planReview) {
    const reviewPayload: Record<string, unknown> = payload as unknown as Record<string, unknown>;
    reviewPayload['plan_review'] = {
      verdict: planReview.review.verdict,
      summary: planReview.review.summary,
      findings: planReview.review.findings,
      risks: planReview.review.risks,
      suggested_changes: planReview.review.suggested_changes,
    };
  }

  const baseHuman = formatLiteResultHuman(payload);
  const humanText = planReview
    ? `${baseHuman}\n${formatPlanReviewHuman(planReview.review)}`
    : baseHuman;

  return {
    payload,
    humanText,
    exitCode: modelPlan.status === 'PLAN_READY' ? 0 : 1,
  };
}
