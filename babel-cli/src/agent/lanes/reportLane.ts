import { join, resolve } from 'node:path';

import {
  formatLiteResultHuman,
  getSchemaRetrySummary,
  type LiteResultPayload,
} from '../../cli/structuredOutput.js';
import { formatLiteContractText } from '../../lite/contract.js';
import { runLitePlan } from '../../agent/provider/textProviderLane.js';
import { runWithPrimaryOnlyFallback } from '../../execute.js';
import { runLaneVerifiers } from '../../stages/verifierContract.js';
import { readLiteProjectContext } from '../../services/liteProjectContext.js';
import {
  consumeLiteSchemaNormalizations,
  LiteReportAnswerSchema,
  type LiteReportAnswer,
} from '../../schemas/liteReadOnlyAnswers.js';
import { recordSchemaNormalizationHints } from '../../services/schemaFailureLedger.js';
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
import {
  buildReadOnlyToolContext,
  mergeDiscoveryAndSynthesisSessionSteps,
  runReadOnlyAgentLoop,
} from './readOnlyAgentLoop.js';

export interface ReportLaneResult {
  payload: LiteResultPayload;
  humanText: string;
  exitCode: number;
}

type ReportIntent = 'compare' | 'audit' | 'diagnose' | 'assess' | 'investigate' | 'report';

function buildModelReportPrompt(input: {
  task: string;
  repoPath: string;
  contractText: string;
  projectContext: string;
}): string {
  return [
    '# Babel Lite Report',
    '',
    'Produce a completed read-only report for the user. Do not modify files. Do not claim source changes.',
    'Return one JSON object exactly matching this shape:',
    '{"schema_version":1,"status":"REPORT_READY","summary":"one sentence","answer":"completed user-facing report","findings":[],"inspected":[],"limitations":[],"verification":[],"next":[]}',
    '',
    'Rules:',
    '- Use completed-analysis language. Prefer "I found" or "The evidence shows" over "I will".',
    '- Findings must be concrete task-relevant conclusions, not process bookkeeping.',
    '- For compare tasks, include at least two compared dimensions, options, tradeoffs, or reliability layers.',
    '- For audit, diagnostic, assessment, or investigation tasks, include at least one observed issue, risk, or bounded conclusion.',
    '- Do not use generic findings like "Primary evidence source" or "No mutation was requested" as the main substance.',
    '- Use status REPORT_READY when the deterministic repo contract gives any relevant evidence, even if the report is bounded.',
    '- Put missing files or uninspected areas in limitations; do not block merely because likely_files or required_reads were not fully opened.',
    '- Use status NEEDS_MORE_CONTEXT only when there is no usable local evidence for the requested report.',
    '- Keep findings grounded in the deterministic repo contract and requested task.',
    '- Use relative file paths from the contract when naming files.',
    '- Required reads in Available Context are already provided; do not request file contents unless a path is marked missing or unreadable.',
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

function formatModelReportText(answer: LiteReportAnswer): string {
  const lines = [answer.answer || answer.summary];
  if (answer.findings.length > 0) {
    lines.push('', 'Findings:', ...answer.findings.map((finding) => `- ${finding}`));
  }
  if (answer.inspected.length > 0) {
    lines.push('', 'Inspected:', ...answer.inspected.map((item) => `- ${item}`));
  }
  if (answer.limitations.length > 0) {
    lines.push('', 'Limitations:', ...answer.limitations.map((item) => `- ${item}`));
  }
  if (answer.verification.length > 0) {
    lines.push('', 'Suggested verification:', ...answer.verification.map((check) => `- ${check}`));
  }
  return lines.join('\n');
}

function classifyReportIntent(task: string): ReportIntent {
  if (/\b(compare|versus|vs\.?|trade-?offs?|options?|paths?)\b/i.test(task)) return 'compare';
  if (/\b(audit|review)\b/i.test(task)) return 'audit';
  if (/\b(diagnos(?:e|is|tic)|debug|why)\b/i.test(task)) return 'diagnose';
  if (/\b(assess|evaluate|score)\b/i.test(task)) return 'assess';
  if (/\b(investigate|inspect|findings?)\b/i.test(task)) return 'investigate';
  return 'report';
}

function firstAvailable(values: string[], fallback: string): string {
  return values.find((value) => value.trim().length > 0) ?? fallback;
}

function joinReadable(values: string[], fallback: string, limit = 3): string {
  const selected = values.filter((value) => value.trim().length > 0).slice(0, limit);
  return selected.length > 0 ? selected.join(', ') : fallback;
}

function buildReportFindings(input: {
  intent: ReportIntent;
  task: string;
  likelyFiles: string[];
  suspectedFiles: string[];
  requiredReads: string[];
  verification: string[];
  riskLane: string;
  riskReasons: string[];
}): string[] {
  const likely = joinReadable(input.likelyFiles, 'no exact likely file match');
  const suspected = joinReadable(input.suspectedFiles, 'no adjacent suspected file match');
  const reads = joinReadable(input.requiredReads, 'the repo contract only');
  const checks = joinReadable(input.verification, 'no verifier candidate detected', 2);
  const risks = joinReadable(input.riskReasons, 'low-risk read-only reporting surface', 2);

  if (input.intent === 'compare') {
    return [
      `Compared direct evidence against adjacent context: likely files are ${likely}, while suspected files are ${suspected}.`,
      `Compared risk and verification tradeoffs: the contract classifies this as ${input.riskLane} because ${risks}; suggested checks are ${checks}.`,
      `Best next step is to inspect ${firstAvailable(input.requiredReads, firstAvailable(input.likelyFiles, 'the likely files'))} before choosing an implementation path.`,
    ];
  }

  if (
    input.intent === 'audit' ||
    input.intent === 'diagnose' ||
    input.intent === 'assess' ||
    input.intent === 'investigate'
  ) {
    return [
      `Observed scope signal: the contract classifies this request as ${input.riskLane} because ${risks}.`,
      `Evidence is concentrated in ${likely}; adjacent context to verify includes ${suspected}.`,
      `Recommended validation is ${checks}, after inspecting ${reads}.`,
    ];
  }

  return [
    `The evidence points to ${likely} as the relevant implementation surface for "${input.task}".`,
    `The report is bounded by ${reads}; adjacent files worth checking are ${suspected}.`,
    `Suggested verification is ${checks}.`,
  ];
}

function buildLocalMockReportAnswer(
  context: AgentLaneContext,
  plan: ReturnType<typeof runLitePlan>,
): LiteReportAnswer {
  const likelyFiles = plan.contract.likely_files.slice(0, 5);
  const requiredReads = plan.contract.required_reads.slice(0, 5);
  const suspectedFiles = plan.contract.suspected_files.slice(0, 5);
  const verification = plan.contract.verification_candidates.slice(0, 5);
  const intent = classifyReportIntent(context.task);
  const findings = buildReportFindings({
    intent,
    task: context.task,
    likelyFiles,
    suspectedFiles,
    requiredReads,
    verification,
    riskLane: plan.contract.risk_lane,
    riskReasons: plan.contract.risk_reasons,
  });
  const answer =
    intent === 'compare'
      ? `The evidence shows ${firstAvailable(likelyFiles, 'the likely file set')} and ${firstAvailable(suspectedFiles, 'the suspected context set')} are the main options to compare for ${context.task}. ${findings[1] ?? findings[0]}`
      : `The evidence shows ${firstAvailable(likelyFiles, firstAvailable(requiredReads, 'the repo contract'))} is the main surface for ${context.task}. ${findings[0]}`;
  return {
    schema_version: 1,
    status: 'REPORT_READY',
    summary: `Prepared a local read-only report for ${context.task}.`,
    answer,
    findings,
    inspected: requiredReads.length > 0 ? requiredReads : likelyFiles,
    limitations:
      plan.contract.warnings.length > 0
        ? plan.contract.warnings
        : [
            `Bounded to deterministic contract evidence; inspect ${firstAvailable(requiredReads, firstAvailable(likelyFiles, 'the target files'))} before implementation.`,
          ],
    verification,
    next: [
      'Review report.md in the artifact directory.',
      'Run babel plan or babel "<task>" if you want follow-up implementation.',
    ],
  };
}

function buildReportProgressJsonl(messages: string[]): string {
  const now = new Date().toISOString();
  return messages
    .map((message, index) =>
      JSON.stringify({
        type: 'progress',
        index,
        message,
        source: 'report_lane',
        ts: now,
      }),
    )
    .join('\n');
}

export async function runReportLane(context: AgentLaneContext): Promise<ReportLaneResult> {
  const repoPath = resolveLiteRepoRoot(context.projectRoot);
  const plan = runLitePlan({ repoPath, task: context.task });
  const { run: artifacts, evidence } = beginLiteEvidenceSession({ command: 'report', repoPath });
  writeLiteTextArtifact(
    artifacts,
    'progress.jsonl',
    buildReportProgressJsonl(['Report started', 'Contract inspected']),
  );
  const contractText = formatLiteContractText(plan.contract);
  const projectContext = await readLiteProjectContext({
    projectRoot: repoPath,
    task: context.task,
    requiredReads: plan.contract.required_reads,
  });
  const useLocalMockReport =
    context.provider === 'mock' || process.env['BABEL_LITE_OFFLINE'] === '1';
  const discovery = await runReadOnlyAgentLoop({
    verb: 'report',
    task: context.task,
    projectRoot: repoPath,
    seedPaths: plan.contract.required_reads,
    toolContext: buildReadOnlyToolContext({
      verb: 'report',
      runId: evidence.runId,
      runDir: evidence.runDir,
    }),
    evidence,
    ...(context.provider === 'mock' || context.provider === 'live'
      ? { provider: context.provider }
      : {}),
    useDeterministicMock: useLocalMockReport,
    ...(context.toolStream !== undefined ? { toolStream: context.toolStream } : {}),
  });
  evidence.writeDebugFile(
    'report_session_loop.json',
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
  const prompt = buildModelReportPrompt({
    task: context.task,
    repoPath,
    contractText,
    projectContext: [
      projectContext,
      '',
      '# Runtime Tool Observations',
      discovery.observations,
    ].join('\n'),
  });

  writeLiteRequest(artifacts, {
    schema_version: 1,
    command: 'report',
    task: context.task,
    project: context.project ?? null,
    project_root: repoPath,
  });
  evidence.writeCompiledContext('lite_report', prompt);
  const modelReport = useLocalMockReport
    ? buildLocalMockReportAnswer(context, plan)
    : await runWithPrimaryOnlyFallback(prompt, LiteReportAnswerSchema, {
        evidence,
        stage: 'planning',
        schemaName: 'LiteReportAnswerSchema',
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
      schemaName: 'LiteReportAnswerSchema',
      normalizations: schemaNormalizations,
    });
  }
  const reportText = formatModelReportText(modelReport);
  evidence.writeDebugFile('lite_report_answer.json', `${JSON.stringify(modelReport, null, 2)}\n`);
  const actStatus: 'pass' | 'fail' | 'blocked' =
    modelReport.status === 'REPORT_READY'
      ? 'pass'
      : modelReport.status === 'NEEDS_MORE_CONTEXT'
        ? 'blocked'
        : 'fail';
  const sessionLoopSteps = mergeDiscoveryAndSynthesisSessionSteps({
    discoverySteps: discovery.sessionLoopSteps,
    act: actStatus,
    verify: 'pass',
    terminal: modelReport.status === 'REPORT_READY' ? 'finish' : 'blocked',
  });
  evidence.writeExecutionLog({
    status: modelReport.status,
    stage_status: 'REPORT_COMPLETE',
    steps_executed: discovery.stepsExecuted,
    tool_call_log: discovery.toolCallLog,
    answer_path: join(evidence.runDir, 'lite_report_answer.json'),
  });
  evidence.writeWaterfallTelemetry();
  const costLedger = buildCostLedger({
    runId: evidence.runId,
    task: context.task,
    lane: 'report',
    waterfallEntries: evidence.getWaterfallLogSnapshot(),
  });
  evidence.writeCostLedger(costLedger);
  artifacts.files['cost_ledger.json'] = join(artifacts.runDir, 'cost_ledger.json');
  writeLiteManifest(artifacts, {
    schema_version: 1,
    command: 'report',
    status: modelReport.status,
    run_id: artifacts.runId,
    task: context.task,
    project_root: repoPath,
    mutation_policy: 'read_only',
  });
  writeLiteTextArtifact(artifacts, 'report.md', reportText);
  writeLiteTextArtifact(artifacts, 'response.md', reportText);
  writeLiteTextArtifact(
    artifacts,
    'progress.jsonl',
    buildReportProgressJsonl(['Report started', 'Contract inspected', 'Report ready']),
  );
  writeLiteJsonArtifact(artifacts, 'model_report.json', modelReport);
  // ── Lane Verifiers (P1.3) ──────────────────────────────────────────────────
  const verifierReport = await runLaneVerifiers({
    runDir: artifacts.runDir,
    task: context.task,
    verb: 'report',
    projectRoot: repoPath,
  });
  writeLiteJsonArtifact(artifacts, 'verification.json', {
    status: verifierReport.overallStatus === 'fail' ? 'attention' : 'not_required',
    reason: 'read-only report lane',
    verifier_report: verifierReport,
  });

  const base = baseReadOnlyLitePayload({
    command: 'report',
    task: context.task,
    project: context.project ?? null,
    runDir: artifacts.runDir,
    projectRoot: repoPath,
    status: modelReport.status,
    userStatus: modelReport.status === 'REPORT_READY' ? 'success' : 'blocked',
    selectedLane: 'lite_report',
    executionPath: discovery.toolCallLog.length > 0 ? 'session_loop' : 'report_lane',
    next: [
      typeof modelReport.next[0] === 'string'
        ? modelReport.next[0]
        : 'Review report.md in the artifact directory.',
      typeof modelReport.next[1] === 'string'
        ? modelReport.next[1]
        : 'Run babel plan or babel "<task>" if you want follow-up implementation.',
    ],
  });

  const schemaRetry = getSchemaRetrySummary(artifacts.runDir);
  const usageSummary = usageSummaryFromCostLedger(costLedger);
  const payload: LiteResultPayload = {
    ...base,
    ...(useLocalMockReport ? { execution_mode: 'offline_demo' as const } : {}),
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
      summary: modelReport.summary,
      answer: modelReport.answer,
      facts: modelReport.findings.length > 0 ? modelReport.findings : plan.contract.likely_files,
      assumptions:
        modelReport.limitations.length > 0 ? modelReport.limitations : plan.contract.warnings,
      read_only_steps:
        modelReport.inspected.length > 0 ? modelReport.inspected : plan.contract.required_reads,
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
    humanText: formatLiteResultHuman(payload),
    exitCode: modelReport.status === 'REPORT_READY' ? 0 : 1,
  };
}
