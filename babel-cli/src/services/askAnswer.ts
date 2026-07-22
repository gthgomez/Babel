import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { BABEL_RUNS_DIR, BABEL_ROOT } from '../cli/constants.js';
import type { EvidenceBundle } from '../evidence.js';
import {
  beginLiteEvidenceSession,
  resolveLiteRepoRoot,
  writeLiteManifest,
  writeLiteRequest,
} from '../agent/liteArtifacts.js';
import { writeLiteTextArtifact } from '../lite/artifacts.js';
import { runWithPrimaryOnlyFallback } from '../execute.js';
import { resolveFamilyModelPolicy, type ResolvedModelPolicy } from '../modelPolicy.js';
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js';
import { DeepSeekApiRunner } from '../runners/deepSeekApi.js';
import type { RunnerInvocationMetadata } from '../runners/base.js';
import { AskAnswerSchema, type AskAnswer } from '../schemas/agentContracts.js';
import { globalCostTracker, type SessionUsageSummary } from './costTracker.js';
import {
  buildCostLedger,
  usageSummaryFromCostLedger,
} from './costLedger.js';
import {
  readShallowTargetListing,
  targetBasename,
} from './targetResolver.js';

export interface RunAskAnswerPathOptions {
  task: string;
  project?: string;
  projectRoot?: string;
  workspaceRoot?: string | null;
  model?: string;
  modelTier?: string;
  allowExpensive?: boolean;
  showModelPolicy?: boolean;
  onChunk?: (chunk: string) => void;
  onStreamReset?: () => void;
}

export interface AskAnswerPathResult {
  status: AskAnswer['status'];
  answer: AskAnswer;
  runDir: string;
  usageSummary: SessionUsageSummary;
  modelPolicy?: ResolvedModelPolicy;
}

interface RecoverableRunError extends Error {
  runDir: string;
  supportPath: string;
  nextCommand: string;
}

function trimForPrompt(value: string, maxChars = 3000): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated]`;
}

function formatDirectoryListing(projectRoot: string): string {
  const listing = readShallowTargetListing(projectRoot);
  if (listing.length === 0) {
    return 'No shallow directory listing was available.';
  }
  return listing.map(entry => `- ${entry}`).join('\n');
}

function taskMentionsTarget(task: string, projectRoot: string): boolean {
  const base = targetBasename(projectRoot).toLowerCase();
  return base.length > 0 && task.toLowerCase().includes(base.toLowerCase());
}

function readProjectSummary(options: RunAskAnswerPathOptions): string {
  const projectRoot = options.projectRoot;
  if (!projectRoot) {
    return 'No project root was provided. Answer from the task text and Babel CLI context only.';
  }

  const root = resolve(projectRoot);
  const candidates = ['AGENTS.md', 'README.md', 'PROJECT_CONTEXT.md', 'package.json'];
  const snippets: string[] = [];
  snippets.push(`Target root: ${root}`);
  if (options.workspaceRoot && resolve(options.workspaceRoot) !== root) {
    snippets.push(`Workspace root: ${resolve(options.workspaceRoot)}\nThe target root is a child project inside this workspace. Prioritize target-local files over parent workspace summaries.`);
  }
  snippets.push(`## Shallow Directory Listing\n${formatDirectoryListing(root)}`);
  if (taskMentionsTarget(options.task, root)) {
    snippets.push(`## Target Name Evidence\nThe task mentions "${targetBasename(root)}", which matches the target directory basename.`);
  }
  for (const name of candidates) {
    const path = join(root, name);
    if (!existsSync(path)) {
      continue;
    }
    try {
      snippets.push(`## ${name}\n${trimForPrompt(readFileSync(path, 'utf-8'), 1800)}`);
    } catch {
      snippets.push(`## ${name}\n[unreadable]`);
    }
  }

  if (snippets.length === 0) {
    return `Project root: ${root}\nNo summary files were found. Do not infer file contents.`;
  }
  return `Project root: ${root}\n${snippets.join('\n\n')}`;
}

export function buildAskPrompt(options: RunAskAnswerPathOptions): string {
  return [
    '# Babel Ask',
    '',
    'Answer the user in read-only mode. Do not propose file edits as completed work. Do not claim you inspected files unless evidence is included below.',
    'Return one JSON object that matches this shape exactly:',
    '{"schema_version":1,"status":"ANSWER_READY","summary":"one sentence","answer":"clear user-facing answer","facts":[],"assumptions":[],"evidence":[],"next":[]}',
    '',
    'Keep the answer concise and useful. Use `NEEDS_MORE_CONTEXT` only when the task cannot be answered responsibly from the provided context.',
    '',
    `Task: ${options.task}`,
    `Project: ${options.project ?? 'auto/unspecified'}`,
    `Target: ${options.projectRoot ? resolve(options.projectRoot) : 'auto/unspecified'}`,
    '',
    '# Available Context',
    readProjectSummary(options),
  ].join('\n');
}

function hasAbsenceClaim(answer: AskAnswer): boolean {
  const text = `${answer.summary}\n${answer.answer}`.toLowerCase();
  return /\b(?:not\s+(?:recognized|found|mentioned|listed|present)|does\s+not\s+appear|no\s+mention|none\s+reference|absent)\b/.test(text);
}

function summarizeTargetFromReadme(projectRoot: string): string | null {
  const readmePath = join(projectRoot, 'README.md');
  if (!existsSync(readmePath)) {
    return null;
  }
  try {
    const lines = readFileSync(readmePath, 'utf-8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('```'));
    const title = lines.find(line => /^#\s+/.test(line))?.replace(/^#+\s*/, '');
    const description = lines.find(line => !line.startsWith('#') && !line.startsWith('|') && !line.startsWith('- '));
    if (title && description) {
      const cleanDescription = description.replace(/\*\*/g, '');
      const sentenceDescription = /^[AI]\b/.test(cleanDescription)
        ? `${cleanDescription.slice(0, 1).toLowerCase()}${cleanDescription.slice(1)}`
        : cleanDescription;
      return `${title} is ${sentenceDescription}`;
    }
    return title ?? description ?? null;
  } catch {
    return null;
  }
}

export function applyAskGroundingReview(answer: AskAnswer, options: RunAskAnswerPathOptions): {
  answer: AskAnswer;
  review: Record<string, unknown>;
} {
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : null;
  if (!projectRoot || !existsSync(projectRoot)) {
    return {
      answer,
      review: {
        schema_version: 1,
        status: 'not_applicable',
        reason: 'No local target root was available.',
      },
    };
  }

  const basenameMatch = taskMentionsTarget(options.task, projectRoot);
  const absenceClaim = hasAbsenceClaim(answer);
  const localSummary = summarizeTargetFromReadme(projectRoot);
  const contradiction = absenceClaim && (basenameMatch || localSummary !== null);
  if (!contradiction) {
    return {
      answer,
      review: {
        schema_version: 1,
        status: 'pass',
        target_root: projectRoot,
        local_evidence_count: 1,
      },
    };
  }

  const targetName = targetBasename(projectRoot);
  const repairedAnswer = localSummary
    ? `${localSummary}.`
    : `${targetName} exists at ${projectRoot}. Babel found local target evidence, so the prior absence claim was not reliable.`;
  return {
    answer: {
      ...answer,
      status: 'ANSWER_READY',
      summary: `${targetName} exists as the active target project`,
      answer: repairedAnswer,
      facts: [
        `${targetName} exists at ${projectRoot}.`,
        ...answer.facts,
      ],
      assumptions: answer.assumptions.filter(assumption => !/absence|absent|not currently part|not recognized/i.test(assumption)),
      evidence: [
        {
          source: 'local_target_evidence',
          summary: localSummary ?? `Directory exists at ${projectRoot}.`,
        },
        ...answer.evidence,
      ],
      next: answer.next.length > 0 ? answer.next : ['Inspect the target README and project context for more detail.'],
    },
    review: {
      schema_version: 1,
      status: 'repaired',
      target_root: projectRoot,
      contradiction: 'unsupported_absence_claim',
      repaired_answer: true,
    },
  };
}

function writeLatestRunPointer(runDir: string, project?: string): void {
  mkdirSync(BABEL_RUNS_DIR, { recursive: true });
  const payload = `${JSON.stringify({
    run_dir: runDir,
    project: project ?? 'global',
    created_at: new Date().toISOString(),
  }, null, 2)}\n`;
  writeFileSync(join(BABEL_RUNS_DIR, '.latest.json'), payload, 'utf-8');
  if (project) {
    writeFileSync(join(BABEL_RUNS_DIR, `.latest.${project}.json`), payload, 'utf-8');
  }
}

function appendDirectRunnerTelemetry(
  evidence: EvidenceBundle,
  metadata: RunnerInvocationMetadata | null,
  succeeded: boolean,
  errorSummary: string | null,
  provider: string,
  attempt = 1,
): void {
  const runnerName = `ask-direct-${provider}`;
  evidence.appendWaterfallLog({
    stage: 'ask',
    tier_succeeded: succeeded ? runnerName : null,
    tier_index: 0,
    attempts: attempt,
    tiers_skipped: [],
    cascade_reason: succeeded ? 'none' : 'failed',
    ts: new Date().toISOString(),
    attempts_detail: [
      {
        tier_name: runnerName,
        tier_index: 0,
        attempt,
        succeeded,
        error_summary: errorSummary,
        provider: metadata?.provider ?? provider,
        provider_model_id: metadata?.provider_model_id ?? null,
        latency_ms: metadata?.latency_ms ?? null,
        prompt_tokens: metadata?.prompt_tokens ?? null,
        completion_tokens: metadata?.completion_tokens ?? null,
        total_tokens: metadata?.total_tokens ?? null,
        prompt_cache_hit_tokens: metadata?.prompt_cache_hit_tokens ?? null,
        prompt_cache_miss_tokens: metadata?.prompt_cache_miss_tokens ?? null,
        estimated_cost_usd: metadata?.estimated_cost_usd ?? null,
        cost_precision: metadata?.cost_precision ?? null,
        pricing_source_url: metadata?.pricing_source_url ?? null,
        pricing_verified_at: metadata?.pricing_verified_at ?? null,
        input_cost_per_1m: metadata?.input_cost_per_1m ?? null,
        output_cost_per_1m: metadata?.output_cost_per_1m ?? null,
        input_cache_hit_cost_per_1m: metadata?.input_cache_hit_cost_per_1m ?? null,
        input_cache_miss_cost_per_1m: metadata?.input_cache_miss_cost_per_1m ?? null,
        ttft_ms: metadata?.ttft_ms ?? null,
        generation_ms: metadata?.generation_ms ?? null,
        validation_ms: metadata?.validation_ms ?? null,
      },
    ],
    total_latency_ms: metadata?.latency_ms ?? null,
    total_prompt_tokens: metadata?.prompt_tokens ?? null,
    total_completion_tokens: metadata?.completion_tokens ?? null,
    total_tokens: metadata?.total_tokens ?? null,
    total_estimated_cost_usd: metadata?.estimated_cost_usd ?? null,
  });
}

function makeRecoverableRunError(message: string, runDir: string): RecoverableRunError {
  const error = new Error(message) as RecoverableRunError;
  error.runDir = runDir;
  error.supportPath = runDir;
  error.nextCommand = 'babel continue latest';
  return error;
}

function failureCodeForError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) {
    return 'provider_timeout';
  }
  if (/zod|schema|invalid json|parse/i.test(message)) {
    return 'provider_schema_invalid';
  }
  return 'provider_request_failed';
}

async function runDirectAsk(
  prompt: string,
  modelPolicy: ResolvedModelPolicy,
  evidence: EvidenceBundle,
  onChunk?: (chunk: string) => void,
): Promise<AskAnswer> {
  const provider = modelPolicy.provider;
  const runner = provider === 'deepseek'
    ? new DeepSeekApiRunner(modelPolicy.providerModelId)
    : new DeepInfraApiRunner(modelPolicy.providerModelId);
  try {
    const callbacks = onChunk ? { onChunk } : undefined;
    const answer = await runner.execute(prompt, AskAnswerSchema, callbacks);
    const metadata = runner.getLastInvocationMetadata?.() ?? null;
    if (metadata?.provider_model_id && metadata.prompt_tokens !== null && metadata.completion_tokens !== null) {
      globalCostTracker.trackUsage(metadata.provider_model_id, metadata.prompt_tokens, metadata.completion_tokens);
    }
    appendDirectRunnerTelemetry(evidence, metadata, true, null, provider);
    return answer;
  } catch (error: unknown) {
    appendDirectRunnerTelemetry(evidence, runner.getLastInvocationMetadata?.() ?? null, false, error instanceof Error ? error.message : String(error), provider);
    throw error;
  }
}

export async function runAskAnswerPath(options: RunAskAnswerPathOptions): Promise<AskAnswerPathResult> {
  const repoPath = resolveLiteRepoRoot(options.projectRoot);
  const { run: liteRun, evidence } = beginLiteEvidenceSession({ command: 'ask', repoPath });
  writeLiteRequest(liteRun, {
    schema_version: 1,
    command: 'ask',
    task: options.task,
    project: options.project ?? null,
    project_root: repoPath,
    target_root: repoPath,
    workspace_root: options.workspaceRoot ?? null,
  });
  const prompt = buildAskPrompt(options);
  globalCostTracker.resetSession();
  evidence.writeCompiledContext('ask', prompt);

  const modelPolicy = options.model
    ? resolveFamilyModelPolicy({
        family: options.model,
        ...(options.modelTier !== undefined ? { requestedTier: options.modelTier } : {}),
        ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
        babelRoot: BABEL_ROOT,
      })
    : undefined;

  let answer: AskAnswer;
  try {
    const runAsk = (onChunk?: (chunk: string) => void) => (modelPolicy?.provider === 'deepinfra' || modelPolicy?.provider === 'deepseek')
      ? runDirectAsk(prompt, modelPolicy, evidence, onChunk)
      : runWithPrimaryOnlyFallback(prompt, AskAnswerSchema, {
          evidence,
          stage: 'orchestrator',
          schemaName: 'AskAnswerSchema',
          maxCliAttempts: 1,
          ...(onChunk ? { onChunk } : {}),
        });
    try {
      answer = await runAsk(options.onChunk);
    } catch (error: unknown) {
      if (options.onChunk && failureCodeForError(error) === 'provider_schema_invalid') {
        options.onStreamReset?.();
        evidence.writeDebugFile('ask_stream_retry.json', `${JSON.stringify({
          schema_version: 1,
          reason: 'streamed_schema_validation_failed',
          retry: 'non_streaming_primary_model',
          error: error instanceof Error ? error.message : String(error),
        }, null, 2)}\n`);
        answer = await runAsk(undefined);
      } else {
        throw error;
      }
    }
  } catch (error: unknown) {
    let message = error instanceof Error ? error.message : String(error);
    if (message.includes('deepseek') || message.includes('DeepSeek') || message.includes('DEEPSEEK_API_KEY')) {
      message = `${message}\n\n[Recovery Hint] Direct DeepSeek request failed. Please check your DEEPSEEK_API_KEY. Alternatively, run in Full Babel mode (governed mode) if backup routes and automated cascading are desired.`;
    } else {
      message = `${message}\n\n[Recovery Hint] Stage execution failed under 'primary_only' policy. Please ensure the primary provider API key is set, or run in Full Babel mode (governed mode) to allow backup cascades.`;
    }
    const failureCode = failureCodeForError(error);
    const failureCapsulePath = join(evidence.runDir, 'ask_failure_capsule.json');
    evidence.writeDebugFile('ask_failure_capsule.json', `${JSON.stringify({
      schema_version: 1,
      failure_capsule_id: `ask_${evidence.runId}`,
      category: failureCode,
      failure_code: failureCode,
      retryable: true,
      condition: message,
      next_recommended_operator_action: 'Retry the same ask or run babel continue latest to inspect recovery evidence.',
    }, null, 2)}\n`);
    evidence.writeExecutionLog({
      status: 'EXECUTION_HALTED',
      stage_status: 'ASK_FAILED',
      steps_executed: 0,
      tool_call_log: [],
      pipeline_error: {
        halt_tag: 'TOOL_CALL_ERROR',
        halted_at_step: 1,
        condition: message,
      },
    });
    evidence.writeDebugFile('terminal_status_summary.json', `${JSON.stringify({
      schema_version: 1,
      artifact_type: 'babel_terminal_status_summary',
      status: 'ASK_FAILED',
      reason_category: failureCode,
      failed_command: 'ask',
      changed_files: [],
      change_disposition: 'none',
      rollback_mode: 'none',
      failure_capsule_path: failureCapsulePath,
      next_recommended_operator_action: 'Retry the same ask or run babel continue latest to inspect recovery evidence.',
      parseable_json_stdout_required: true,
      attempt_safety_summary_path: null,
      repair_attempt_timeline_path: null,
      condition_summary: message,
      verifier_contract: null,
    }, null, 2)}\n`);
    evidence.writeWaterfallTelemetry();
    evidence.writeCostLedger(buildCostLedger({
      runId: evidence.runId,
      task: options.task,
      lane: 'ask',
      waterfallEntries: evidence.getWaterfallLogSnapshot(),
    }));
    writeLatestRunPointer(evidence.runDir, options.project);
    evidence.writeDebugFile('ask_usage.json', `${JSON.stringify(globalCostTracker.getSessionSummary(), null, 2)}\n`);
    throw makeRecoverableRunError(message, evidence.runDir);
  }
  const grounding = applyAskGroundingReview(answer, { ...options, projectRoot: repoPath });
  answer = grounding.answer;
  evidence.writeDebugFile('ask_grounding_review.json', `${JSON.stringify(grounding.review, null, 2)}\n`);

  evidence.writeDebugFile('ask_answer.json', `${JSON.stringify(answer, null, 2)}\n`);
  evidence.writeExecutionLog({
    status: 'ANSWER_READY',
    stage_status: 'ASK_COMPLETE',
    steps_executed: 0,
    tool_call_log: [],
    answer_path: join(evidence.runDir, 'ask_answer.json'),
  });
  evidence.writeDebugFile('terminal_status_summary.json', `${JSON.stringify({
    schema_version: 1,
    artifact_type: 'babel_terminal_status_summary',
    status: answer.status,
    reason_category: 'read_only_answer',
    failed_command: null,
    changed_files: [],
    change_disposition: 'none',
    rollback_mode: 'none',
    failure_capsule_path: null,
    next_recommended_operator_action: answer.status === 'ANSWER_READY'
      ? 'No operator action required; read-only answer completed.'
      : 'Provide more context, then rerun ask.',
    parseable_json_stdout_required: true,
    attempt_safety_summary_path: null,
    repair_attempt_timeline_path: null,
    condition_summary: answer.status === 'ANSWER_READY' ? null : answer.summary,
    verifier_contract: null,
  }, null, 2)}\n`);
  evidence.writeWaterfallTelemetry();
  const costLedger = buildCostLedger({
    runId: evidence.runId,
    task: options.task,
    lane: 'ask',
    waterfallEntries: evidence.getWaterfallLogSnapshot(),
  });
  evidence.writeCostLedger(costLedger);
  writeLiteManifest(liteRun, {
    schema_version: 1,
    command: 'ask',
    status: answer.status,
    run_id: liteRun.runId,
    task: options.task,
    mutation_policy: 'read_only',
  });
  writeLiteTextArtifact(liteRun, 'response.md', answer.answer || answer.summary);
  writeLatestRunPointer(evidence.runDir, options.project);

  const usageSummary = costLedger.entries.length > 0
    ? usageSummaryFromCostLedger(costLedger)
    : globalCostTracker.getSessionSummary();
  evidence.writeDebugFile('ask_usage.json', `${JSON.stringify(usageSummary, null, 2)}\n`);

  return {
    status: answer.status,
    answer,
    runDir: evidence.runDir,
    usageSummary,
    ...(modelPolicy !== undefined ? { modelPolicy } : {}),
  };
}

export function getAskEvidenceLabel(runDir: string): string {
  return basename(runDir);
}
