import { join, resolve } from 'node:path';

import { z } from 'zod';

import { formatLiteResultHuman, type LiteResultPayload } from '../../cli/structuredOutput.js';
import { formatLiteContractText } from '../../lite/contract.js';
import { runLitePlan } from '../../agent/provider/textProviderLane.js';
import { runWithPrimaryOnlyFallback } from '../../execute.js';
import {
  baseReadOnlyLitePayload,
  type AgentLaneContext,
} from '../contracts.js';
import {
  beginLiteEvidenceSession,
  listArtifactPaths,
  resolveLiteRepoRoot,
  writeLiteManifest,
  writeLiteRequest,
} from '../liteArtifacts.js';
import { writeLiteJsonArtifact, writeLiteTextArtifact } from '../../lite/artifacts.js';
import { buildCostLedger, usageSummaryFromCostLedger } from '../../services/costLedger.js';

export interface PlanLaneResult {
  payload: LiteResultPayload;
  humanText: string;
  exitCode: number;
}

const LitePlanAnswerSchema = z.object({
  schema_version: z.literal(1),
  status: z.enum(['PLAN_READY', 'NEEDS_MORE_CONTEXT']),
  summary: z.string().min(1),
  answer: z.string().min(1),
  steps: z.array(z.string()).default([]),
  likely_files: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  verification: z.array(z.string()).default([]),
  next: z.array(z.string()).default([]),
});

type LitePlanAnswer = z.infer<typeof LitePlanAnswerSchema>;

function buildModelPlanPrompt(input: {
  task: string;
  repoPath: string;
  contractText: string;
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
    '- If the context is insufficient, use status NEEDS_MORE_CONTEXT and explain what is missing.',
    '',
    `Task: ${input.task}`,
    `Target: ${input.repoPath}`,
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
    ...(answer.steps.length > 0 ? answer.steps.map((step, index) => `${index + 1}. ${step}`) : ['1. Review the task and target files.']),
  ];
  if (answer.likely_files.length > 0) {
    lines.push('', 'Likely files:', ...answer.likely_files.map(file => `- ${file}`));
  }
  if (answer.risks.length > 0) {
    lines.push('', 'Risks:', ...answer.risks.map(risk => `- ${risk}`));
  }
  if (answer.verification.length > 0) {
    lines.push('', 'Verification:', ...answer.verification.map(check => `- ${check}`));
  }
  return lines.join('\n');
}

function buildLocalMockPlanAnswer(context: AgentLaneContext, plan: ReturnType<typeof runLitePlan>): LitePlanAnswer {
  const likelyFiles = plan.contract.likely_files.slice(0, 5);
  const requiredReads = plan.contract.required_reads.slice(0, 5);
  return {
    schema_version: 1,
    status: 'PLAN_READY',
    summary: `Prepared a local read-only plan for ${context.task}.`,
    answer: `Prepared a local read-only plan. Start by reading ${requiredReads[0] ?? 'the target files'}, then apply the smallest safe change path if you choose to run a fix.`,
    steps: [
      ...requiredReads.map(read => `Inspect ${read}.`),
      'Decide whether to propose a patch or run a targeted fix.',
      'Run the verifier before considering the work complete.',
    ].slice(0, 6),
    likely_files: likelyFiles,
    risks: plan.contract.warnings,
    verification: plan.contract.verification_candidates,
    next: ['Review plan.md in the artifact directory.', 'Run bl propose or bl fix when ready to continue.'],
  };
}

export async function runPlanLane(context: AgentLaneContext): Promise<PlanLaneResult> {
  const repoPath = resolveLiteRepoRoot(context.projectRoot);
  const plan = runLitePlan({ repoPath, task: context.task });
  const { run: artifacts, evidence } = beginLiteEvidenceSession({ command: 'plan', repoPath });
  const planText = formatLiteContractText(plan.contract);
  const prompt = buildModelPlanPrompt({
    task: context.task,
    repoPath,
    contractText: planText,
  });

  writeLiteRequest(artifacts, {
    schema_version: 1,
    command: 'plan',
    task: context.task,
    project: context.project ?? null,
    project_root: repoPath,
  });
  evidence.writeCompiledContext('lite_plan', prompt);
  const useLocalMockPlan = context.provider === 'mock' || process.env['BABEL_LITE_OFFLINE'] === '1';
  const modelPlan = useLocalMockPlan
    ? buildLocalMockPlanAnswer(context, plan)
    : await runWithPrimaryOnlyFallback(prompt, LitePlanAnswerSchema, {
        evidence,
        stage: 'planning',
        schemaName: 'LitePlanAnswerSchema',
        maxCliAttempts: 1,
      });
  const modelPlanText = formatModelPlanText(modelPlan);
  evidence.writeDebugFile('lite_plan_answer.json', `${JSON.stringify(modelPlan, null, 2)}\n`);
  evidence.writeExecutionLog({
    status: modelPlan.status,
    stage_status: 'PLAN_COMPLETE',
    steps_executed: 0,
    tool_call_log: [],
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
    mutation_policy: 'read_only',
  });
  writeLiteTextArtifact(artifacts, 'plan.md', modelPlanText);
  writeLiteTextArtifact(artifacts, 'response.md', modelPlanText);
  writeLiteJsonArtifact(artifacts, 'model_plan.json', modelPlan);
  writeLiteJsonArtifact(artifacts, 'verification.json', {
    status: 'not_required',
    reason: 'read-only plan lane',
  });
  if (context.sparkSynthesis) {
    writeLiteJsonArtifact(artifacts, 'spark_synthesis.json', context.sparkSynthesis);
  }

  const base = baseReadOnlyLitePayload({
    command: 'plan',
    task: context.task,
    project: context.project ?? null,
    runDir: artifacts.runDir,
    projectRoot: repoPath,
    status: modelPlan.status,
    userStatus: modelPlan.status === 'PLAN_READY' ? 'success' : 'blocked',
    selectedLane: 'lite_plan',
    executionPath: 'plan_lane',
    next: [
      modelPlan.next[0] ?? 'Review plan.md in the artifact directory.',
      modelPlan.next[1] ?? 'Run bl propose or bl fix when ready to continue.',
    ],
  });

  const usageSummary = usageSummaryFromCostLedger(costLedger);
  const payload: LiteResultPayload = {
    ...base,
    schema_retries: 0,
    recovered_after_schema_retry: false,
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
      facts: modelPlan.likely_files.length > 0 ? modelPlan.likely_files : plan.contract.likely_files,
      assumptions: modelPlan.risks.length > 0 ? modelPlan.risks : plan.contract.warnings,
      read_only_steps: plan.contract.required_reads,
    },
    ...(context.routeDecision ? {
      route_reason: context.routeDecision.route_reason,
      complexity: context.routeDecision.complexity,
      risk_signals: context.routeDecision.risk_signals,
      model_tier_recommendation: context.routeDecision.model_tier_recommendation,
      full_babel_equivalent: context.routeDecision.full_babel_equivalent,
    } : {}),
    ...(context.sparkSynthesis ? { spark_synthesis: context.sparkSynthesis } : {}),
    ...(context.sparkReview ? {
      spark_agents: context.sparkReview.spark_agents,
      spark_run_dir: context.sparkReview.run_dir,
      spark_synthesis_path: context.sparkReview.synthesis_path,
    } : {}),
  } as LiteResultPayload;

  return {
    payload,
    humanText: formatLiteResultHuman(payload),
    exitCode: modelPlan.status === 'PLAN_READY' ? 0 : 1,
  };
}
