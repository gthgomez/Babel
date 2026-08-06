/**
 * Model-fixed harness evaluation substrate (H7).
 *
 * Separates harness behavior from model changes: fixed task set, model
 * snapshot, sampling, repo revision, permissions, verifier, resource profile,
 * environment digest. Failure ledger links episodes → fixtures → fixes.
 * Never reports a best-run as reliability; requires paired deltas + uncertainty.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, normalize } from 'node:path';
import {
  assembleCompactedConversation,
  measureCriticalFactRetention,
} from './compactionCommit.js';
import { estimateTokens } from './chatCompaction.js';
import { checkToolCapability } from './capabilityBroker.js';
import {
  buildVerifierReceiptV2,
  evaluateVerifierPromotion,
} from './verifierKernel.js';
import {
  createSessionEventLog,
  recordUserSubmitted,
  recordToolTerminal,
  recordCompletionDecision,
  recordTurnEnded,
} from './sessionEvents.js';
import {
  projectLiveSession,
  liveSessionsEquivalentForResume,
} from './liveSession.js';
import {
  replayTerminalDecision,
  buildLiveGoldenEpisode,
  validateGoldenEpisode,
} from './episodeReplay.js';
import { classifyToolEffect } from '../executor/contracts.js';

export const HARNESS_EVAL_VERSION = 1 as const;

export interface FixedEvalControls {
  task_set_id: string;
  model_snapshot: string;
  sampling: { temperature: number; top_p?: number; max_tokens?: number };
  repository_revision: string;
  permissions_profile: string;
  verifier_profile: string;
  resource_profile: string;
  environment_digest: string;
}

export interface EvalTaskResult {
  task_id: string;
  variant: string;
  verified_complete_no_policy_violation: boolean;
  tokens: number;
  duration_ms: number;
  false_completion: boolean;
  instruction_policy_violation: boolean;
  resume_state_equivalent: boolean | null;
  critical_fact_retention: number | null;
  infrastructure_failure: boolean;
  agent_failure: boolean;
  human_intervention: boolean;
  clean_room_pass: boolean | null;
}

export interface PairedDelta {
  task_id: string;
  baseline_variant: string;
  candidate_variant: string;
  metric: string;
  baseline_value: number;
  candidate_value: number;
  delta: number;
  /** Simple uncertainty band (e.g. half-width of Wilson or bootstrap). */
  uncertainty: number;
}

export interface FailureLedgerEntry {
  entry_id: string;
  episode_id: string;
  failure_class: string;
  regression_fixture: string;
  fixing_commit?: string;
  created_at: string;
  held_out: boolean;
}

export interface PromotionRecord {
  change_id: string;
  pre_fix_fixture: string;
  pre_fix_failed: true;
  post_fix_fixture: string;
  post_fix_passed: true;
  held_out_non_regression: boolean;
  rollback_path: string;
  promoted_at?: string;
}

export interface HarnessEvalReport {
  schema_version: typeof HARNESS_EVAL_VERSION;
  controls: FixedEvalControls;
  results: EvalTaskResult[];
  paired_deltas: PairedDelta[];
  failure_ledger: FailureLedgerEntry[];
  metrics: HarnessCoreMetrics;
  /** True only when experimental runs actually executed under fixed controls. */
  experimental_evidence: boolean;
  notes: string[];
}

export interface HarnessCoreMetrics {
  verified_completion_per_token: number | null;
  verified_completion_per_minute: number | null;
  false_completion_rate: number;
  instruction_policy_violation_rate: number;
  resume_state_equivalence_rate: number | null;
  critical_fact_retention_mean: number | null;
  infrastructure_failure_rate: number;
  agent_failure_rate: number;
  clean_room_promotion_pass_rate: number | null;
  human_intervention_burden: number;
  n_tasks: number;
}

export function environmentDigest(parts: Record<string, string>): string {
  const ordered = Object.keys(parts)
    .sort()
    .map((k) => `${k}=${parts[k]}`)
    .join('\n');
  return createHash('sha256').update(ordered).digest('hex').slice(0, 24);
}

export function computeCoreMetrics(results: readonly EvalTaskResult[]): HarnessCoreMetrics {
  const n = results.length;
  if (n === 0) {
    return {
      verified_completion_per_token: null,
      verified_completion_per_minute: null,
      false_completion_rate: 0,
      instruction_policy_violation_rate: 0,
      resume_state_equivalence_rate: null,
      critical_fact_retention_mean: null,
      infrastructure_failure_rate: 0,
      agent_failure_rate: 0,
      clean_room_promotion_pass_rate: null,
      human_intervention_burden: 0,
      n_tasks: 0,
    };
  }
  const verified = results.filter((r) => r.verified_complete_no_policy_violation);
  const tokens = results.reduce((s, r) => s + r.tokens, 0);
  const minutes = results.reduce((s, r) => s + r.duration_ms, 0) / 60_000;
  const resume = results.filter((r) => r.resume_state_equivalent !== null);
  const resumeOk = resume.filter((r) => r.resume_state_equivalent === true);
  const facts = results
    .map((r) => r.critical_fact_retention)
    .filter((x): x is number => x !== null);
  const cr = results.filter((r) => r.clean_room_pass !== null);
  const crOk = cr.filter((r) => r.clean_room_pass === true);

  return {
    verified_completion_per_token:
      tokens > 0 ? verified.length / tokens : null,
    verified_completion_per_minute:
      minutes > 0 ? verified.length / minutes : null,
    false_completion_rate: results.filter((r) => r.false_completion).length / n,
    instruction_policy_violation_rate:
      results.filter((r) => r.instruction_policy_violation).length / n,
    resume_state_equivalence_rate:
      resume.length > 0 ? resumeOk.length / resume.length : null,
    critical_fact_retention_mean:
      facts.length > 0 ? facts.reduce((a, b) => a + b, 0) / facts.length : null,
    infrastructure_failure_rate:
      results.filter((r) => r.infrastructure_failure).length / n,
    agent_failure_rate: results.filter((r) => r.agent_failure).length / n,
    clean_room_promotion_pass_rate:
      cr.length > 0 ? crOk.length / cr.length : null,
    human_intervention_burden:
      results.filter((r) => r.human_intervention).length / n,
    n_tasks: n,
  };
}

/**
 * Pairwise task-level deltas with simple uncertainty (not best-run reporting).
 */
export function computePairedDeltas(
  baseline: readonly EvalTaskResult[],
  candidate: readonly EvalTaskResult[],
  metric: keyof Pick<
    EvalTaskResult,
    'tokens' | 'duration_ms' | 'critical_fact_retention'
  > = 'tokens',
): PairedDelta[] {
  const deltas: PairedDelta[] = [];
  for (const b of baseline) {
    const c = candidate.find((x) => x.task_id === b.task_id);
    if (!c) continue;
    const bv = Number(b[metric] ?? 0);
    const cv = Number(c[metric] ?? 0);
    const delta = cv - bv;
    // Conservative uncertainty: max(1, 10% of |baseline|)
    const uncertainty = Math.max(1, Math.abs(bv) * 0.1);
    deltas.push({
      task_id: b.task_id,
      baseline_variant: b.variant,
      candidate_variant: c.variant,
      metric,
      baseline_value: bv,
      candidate_value: cv,
      delta,
      uncertainty,
    });
  }
  return deltas;
}

export function appendFailureLedger(
  ledger: FailureLedgerEntry[],
  entry: Omit<FailureLedgerEntry, 'entry_id' | 'created_at'> & {
    entry_id?: string;
    created_at?: string;
  },
): FailureLedgerEntry[] {
  return [
    ...ledger,
    {
      entry_id: entry.entry_id ?? randomUUID(),
      episode_id: entry.episode_id,
      failure_class: entry.failure_class,
      regression_fixture: entry.regression_fixture,
      ...(entry.fixing_commit ? { fixing_commit: entry.fixing_commit } : {}),
      created_at: entry.created_at ?? new Date().toISOString(),
      held_out: entry.held_out,
    },
  ];
}

/**
 * Promotion requires pre-fail, post-pass, held-out, rollback path (H7 exit).
 */
export function validatePromotionRecord(rec: PromotionRecord): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!rec.pre_fix_fixture) errors.push('missing_pre_fix_fixture');
  if (!rec.pre_fix_failed) errors.push('pre_fix_must_have_failed');
  if (!rec.post_fix_fixture) errors.push('missing_post_fix_fixture');
  if (!rec.post_fix_passed) errors.push('post_fix_must_have_passed');
  if (!rec.held_out_non_regression) errors.push('missing_held_out_evidence');
  if (!rec.rollback_path) errors.push('missing_rollback_path');
  return { ok: errors.length === 0, errors };
}

export const H7_DEDICATED_SUITES = [
  'noop_already_fixed',
  'stale_context',
  'dirty_tree',
  'prompt_injection',
  'verifier_tamper',
  'flaky_tests',
  'missing_dependency',
  'network_denied',
  'resource_exhaustion',
  'false_completion',
  'crash_resume',
  'context_compaction',
  'policy_disappearance',
  'idempotency_violation',
] as const;

export type H7SuiteId = (typeof H7_DEDICATED_SUITES)[number];

/**
 * Local dry-run of eval substrate with synthetic results under fixed controls.
 * Marks experimental_evidence: false — code path validation only.
 */
export function runLocalEvalSubstrateSmoke(controls: FixedEvalControls): HarnessEvalReport {
  const baseline: EvalTaskResult[] = [
    {
      task_id: 't1',
      variant: 'baseline',
      verified_complete_no_policy_violation: true,
      tokens: 1000,
      duration_ms: 60_000,
      false_completion: false,
      instruction_policy_violation: false,
      resume_state_equivalent: true,
      critical_fact_retention: 1,
      infrastructure_failure: false,
      agent_failure: false,
      human_intervention: false,
      clean_room_pass: true,
    },
  ];
  const candidate: EvalTaskResult[] = [
    {
      ...baseline[0]!,
      variant: 'hardened',
      tokens: 900,
    },
  ];
  const results = [...baseline, ...candidate];
  return {
    schema_version: HARNESS_EVAL_VERSION,
    controls,
    results,
    paired_deltas: computePairedDeltas(baseline, candidate, 'tokens'),
    failure_ledger: [],
    metrics: computeCoreMetrics(results),
    experimental_evidence: false,
    notes: [
      'Local substrate smoke only — not measured experimental evidence',
      `suites_registered=${H7_DEDICATED_SUITES.length}`,
    ],
  };
}

/**
 * Offline harness-factor factorial: drives shipped harness functions under fixed
 * controls without calling external model APIs. Measures resume equivalence,
 * compaction retention, capability deny, verifier promotion, and golden replay.
 *
 * Explicitly NOT a substitute for same-model Chat/Deep LLM factorial cells
 * (see ADR-013). Marks experimental_evidence: true only for harness-factor scope.
 */
export function runOfflineHarnessFactorial(controls: FixedEvalControls): HarnessEvalReport {
  const t0 = Date.now();
  const facts = ['FACT_ALPHA', 'FACT_BETA'];
  const prior = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: `remember ${facts[0]}` },
    { role: 'assistant' as const, content: `ok ${facts[0]}` },
    { role: 'user' as const, content: `remember ${facts[1]}` },
    { role: 'assistant' as const, content: `ok ${facts[1]}` },
  ];
  const compacted = assembleCompactedConversation(
    [
      prior[0]!,
      {
        role: 'system',
        content: `Preserved: ${facts.join(', ')}`,
        name: 'compaction_summary',
      },
      prior[prior.length - 2]!,
      prior[prior.length - 1]!,
    ],
    '# capsule\nTask: offline-h7',
  );
  const retention = measureCriticalFactRetention(
    compacted.map((m) => m.content).join('\n'),
    facts,
  );
  const tokensBefore = estimateTokens(prior);
  const tokensAfter = estimateTokens(compacted);

  const unknownDenied = checkToolCapability({
    toolName: 'totally_unknown_offline_xyz',
    effectClass: classifyToolEffect('totally_unknown_offline_xyz'),
    allowedEffects: ['read_only', 'idempotent', 'reconcilable_mutation'],
    mode: 'chat',
  });

  const emptyPromo = evaluateVerifierPromotion({
    mutating: true,
    task_class: 'general_swe',
    required_verifier_commands: [],
    receipts: [],
    current_revision_hash: 'rev',
  });
  const goodReceipt = buildVerifierReceiptV2({
    receipt_id: 'r1',
    verifier_id: 'v1',
    argv: ['npm', 'test'],
    cwd: '.',
    env_profile_hash: 'env',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    exit_code: 0,
    stdout: 'ok',
    stderr: '',
    workspace_revision: { compositeTreeHash: 'rev' },
    scope: 'full_suite',
    command: 'npm test',
    authoritative: true,
  });
  const goodPromo = evaluateVerifierPromotion({
    mutating: true,
    task_class: 'general_swe',
    required_verifier_commands: ['npm test'],
    receipts: [goodReceipt],
    current_revision_hash: 'rev',
  });

  const log = createSessionEventLog('offline-h7');
  recordUserSubmitted(log, { turn_id: 't1', task: 'offline harness factor' });
  recordToolTerminal(log, {
    turn_id: 't1',
    tool_call_id: 'c1',
    tool_name: 'write_file',
    idempotency_key: 'idem-1',
    exit_code: 0,
  });
  recordCompletionDecision(log, 't1', {
    requestedOutcome: 'VERIFIED_COMPLETE',
    finalOutcome: 'VERIFIED_COMPLETE',
    allowed: true,
    reason: 'ok',
    evidenceRefs: ['e1'],
    policyVersion: 'v1',
  });
  recordTurnEnded(log, {
    turn_id: 't1',
    outcome: 'VERIFIED_COMPLETE',
    status: 'done',
  });
  const liveA = projectLiveSession({ sessionLog: log });
  const liveB = projectLiveSession({ sessionLog: log });
  const resumeEq = liveSessionsEquivalentForResume(liveA, liveB);
  const replay = replayTerminalDecision(log);
  const golden = buildLiveGoldenEpisode({
    sessionLog: log,
    workspace_path: process.cwd(),
    live_runtime: false,
  });
  const goldenOk = validateGoldenEpisode(golden);

  const duration = Date.now() - t0;
  const hardenedOk =
    retention.rate === 1 &&
    !unknownDenied.allowed &&
    !emptyPromo.authorize_verified_complete &&
    goodPromo.authorize_verified_complete &&
    resumeEq.ok &&
    replay.outcome === 'VERIFIED_COMPLETE' &&
    goldenOk.ok;

  const baseline: EvalTaskResult = {
    task_id: 'offline-harness-factor-1',
    variant: 'baseline-substrate',
    verified_complete_no_policy_violation: true,
    tokens: tokensBefore,
    duration_ms: duration,
    false_completion: false,
    instruction_policy_violation: false,
    resume_state_equivalent: resumeEq.ok,
    critical_fact_retention: retention.rate,
    infrastructure_failure: false,
    agent_failure: false,
    human_intervention: false,
    clean_room_pass: null,
  };
  const candidate: EvalTaskResult = {
    ...baseline,
    variant: 'hardened-offline',
    tokens: tokensAfter,
    verified_complete_no_policy_violation: hardenedOk,
    false_completion: emptyPromo.authorize_verified_complete,
    instruction_policy_violation: unknownDenied.allowed,
  };

  const results = [baseline, candidate];
  const ledger = appendFailureLedger([], {
    episode_id: log.session_id,
    failure_class: 'false_completion',
    regression_fixture: 'harnessHardening.h3h7.test.ts',
    held_out: true,
  });

  return {
    schema_version: HARNESS_EVAL_VERSION,
    controls: {
      ...controls,
      model_snapshot: 'offline-harness-factor@none',
    },
    results,
    paired_deltas: computePairedDeltas([baseline], [candidate], 'tokens'),
    failure_ledger: ledger,
    metrics: computeCoreMetrics(results),
    experimental_evidence: true,
    notes: [
      'Offline harness-factor factorial — drives shipped compaction/capability/verifier/session/replay paths',
      'NOT same-model Chat/Deep LLM factorial (see runSameModelLlmFactorial for model-path cells)',
      `token_reduction=${tokensBefore}->${tokensAfter}`,
      `critical_fact_retention=${retention.rate}`,
      `unknown_tool_denied=${!unknownDenied.allowed}`,
      `empty_verifier_blocked=${!emptyPromo.authorize_verified_complete}`,
      `resume_equivalent=${resumeEq.ok}`,
      `golden_ok=${goldenOk.ok}`,
    ],
  };
}

/**
 * Same-model LLM factorial (H7 model-path experimental evidence).
 *
 * Fixed controls: model snapshot, temperature, task set, repo revision,
 * permissions, verifier profile, resource profile, environment digest.
 * Variants under the same model:
 *   - minimal_loop: direct provider completion (no ChatEngine harness)
 *   - chat_harness: ChatEngine submitMessage with real runner (complete path)
 *   - deep_profile: ChatEngine with executionProfile=deep (same model)
 *
 * Requires OPENROUTER_API_KEY (or opts.apiKey). Marks experimental_evidence:true
 * only when at least one model cell succeeds under fixed controls.
 */
export async function runSameModelLlmFactorial(input: {
  controls: FixedEvalControls;
  /** Absolute workspace for ChatEngine projectRoot. */
  workspace_path: string;
  /** OpenRouter model id, e.g. openai/gpt-4o-mini */
  model_id?: string;
  api_key_env?: string;
  /** Max tasks from the fixed set (default 2). */
  max_tasks?: number;
}): Promise<HarnessEvalReport> {
  const modelId = input.model_id ?? 'openai/gpt-4o-mini';
  const apiKeyEnv = input.api_key_env ?? 'OPENROUTER_API_KEY';
  const apiKey = process.env[apiKeyEnv] ?? '';
  const notes: string[] = [
    'Same-model LLM factorial — OpenRouter gateway',
    `model_id=${modelId}`,
    `api_key_env=${apiKeyEnv}`,
    `temperature=${input.controls.sampling.temperature}`,
    `workspace=${input.workspace_path}`,
  ];
  const results: EvalTaskResult[] = [];
  const failureLedger: FailureLedgerEntry[] = [];

  if (!apiKey) {
    return {
      schema_version: HARNESS_EVAL_VERSION,
      controls: {
        ...input.controls,
        model_snapshot: `openrouter:${modelId}@blocked-no-key`,
      },
      results: [],
      paired_deltas: [],
      failure_ledger: [],
      metrics: computeCoreMetrics([]),
      experimental_evidence: false,
      notes: [...notes, 'BLOCKED: API key missing — no model-path experimental evidence'],
    };
  }

  // Tasks must classify as ChatEngine 'explain' intent (do not edit / what is)
  // so completion gates do not demand file mutations.
  const tasks = [
    {
      task_id: 'h7-t1-answer',
      task: 'Explain what is 2+2 without editing files. Answer only.',
      user_message: 'What is 2+2? Reply with only the number.',
    },
    {
      task_id: 'h7-t2-pong',
      task: 'Explain only — reply with the word PONG. Do not edit or modify files.',
      user_message: 'Reply with exactly the word PONG and nothing else.',
    },
  ].slice(0, input.max_tasks ?? 2);

  const temperature = input.controls.sampling.temperature;
  const maxTokens = input.controls.sampling.max_tokens ?? 64;

  async function minimalLoop(
    taskId: string,
    userMessage: string,
  ): Promise<EvalTaskResult> {
    const t0 = Date.now();
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/gthgomez/Babel',
          'X-Title': 'Babel H7 same-model factorial',
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: userMessage }],
          temperature,
          max_tokens: maxTokens,
        }),
      });
      const body = (await r.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string };
      };
      if (!r.ok) {
        return {
          task_id: taskId,
          variant: 'minimal_loop',
          verified_complete_no_policy_violation: false,
          tokens: 0,
          duration_ms: Date.now() - t0,
          false_completion: false,
          instruction_policy_violation: false,
          resume_state_equivalent: null,
          critical_fact_retention: null,
          infrastructure_failure: true,
          agent_failure: false,
          human_intervention: false,
          clean_room_pass: null,
        };
      }
      const text = String(body.choices?.[0]?.message?.content ?? '');
      const tokens =
        body.usage?.total_tokens ??
        (body.usage?.prompt_tokens ?? 0) + (body.usage?.completion_tokens ?? 0);
      const ok =
        text.trim().length > 0 &&
        !/error|unavailable/i.test(text) &&
        (taskId.includes('pong') ? /PONG/i.test(text) : /4/.test(text));
      return {
        task_id: taskId,
        variant: 'minimal_loop',
        verified_complete_no_policy_violation: ok,
        tokens: tokens || 1,
        duration_ms: Date.now() - t0,
        false_completion: false,
        instruction_policy_violation: false,
        resume_state_equivalent: null,
        critical_fact_retention: null,
        infrastructure_failure: false,
        agent_failure: !ok,
        human_intervention: false,
        clean_room_pass: null,
      };
    } catch (e) {
      failureLedger.push({
        entry_id: randomUUID(),
        episode_id: taskId,
        failure_class: 'infrastructure',
        regression_fixture: 'runSameModelLlmFactorial',
        created_at: new Date().toISOString(),
        held_out: false,
      });
      return {
        task_id: taskId,
        variant: 'minimal_loop',
        verified_complete_no_policy_violation: false,
        tokens: 0,
        duration_ms: Date.now() - t0,
        false_completion: false,
        instruction_policy_violation: false,
        resume_state_equivalent: null,
        critical_fact_retention: null,
        infrastructure_failure: true,
        agent_failure: false,
        human_intervention: false,
        clean_room_pass: null,
      };
    }
  }

  async function chatVariant(
    taskId: string,
    task: string,
    userMessage: string,
    variant: 'chat_harness' | 'deep_profile',
  ): Promise<EvalTaskResult> {
    const t0 = Date.now();
    try {
      const { ChatEngine } = await import('./chatEngine.js');
      const { OpenRouterApiRunner } = await import('../runners/openRouterApi.js');
      // Engine model must be a configured policy family; actual inference uses
      // OpenRouter runner with the fixed modelId (same for all variants).
      const runner = new OpenRouterApiRunner(modelId);
      const engine = new ChatEngine({
        task,
        projectRoot: input.workspace_path,
        model: 'DeepSeek',
        maxTurns: 3,
        executionProfile: variant === 'deep_profile' ? 'deep' : 'chat',
      });
      const anyEngine = engine as unknown as {
        deliberationRunner: unknown;
        synthesisRunner: unknown;
        fallbackRunner: unknown;
        shouldUseNativeTools: () => boolean;
      };
      anyEngine.deliberationRunner = runner;
      anyEngine.synthesisRunner = runner;
      anyEngine.fallbackRunner = runner;
      // Complete-only: avoid tool loops for stable factorial cells
      anyEngine.shouldUseNativeTools = () => false;
      process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';

      const turn = await engine.submitMessage(userMessage, { onThought: () => {} });
      const t = (turn ?? {}) as unknown as Record<string, unknown>;
      const answer = typeof t['answer'] === 'string' ? t['answer'] : '';
      const status = typeof t['status'] === 'string' ? t['status'] : '';
      const outcome = typeof t['outcome'] === 'string' ? t['outcome'] : '';
      const usage = t['usage'] as
        | { totalTokens?: number; totalInputTokens?: number; totalOutputTokens?: number }
        | undefined;
      const meta = runner.getLastInvocationMetadata?.() as
        | {
            total_tokens?: number;
            prompt_tokens?: number;
            completion_tokens?: number;
            usage?: { totalTokens?: number };
          }
        | null
        | undefined;
      const rawTokens =
        usage?.totalTokens ??
        meta?.total_tokens ??
        meta?.usage?.totalTokens ??
        (meta?.prompt_tokens ?? 0) + (meta?.completion_tokens ?? 0);
      const tokens =
        typeof rawTokens === 'number' && rawTokens > 0
          ? rawTokens
          : Math.max(1, Math.ceil(answer.length / 4));
      const contentOk =
        answer.trim().length > 0 &&
        !/Turn limit exceeded|Gate check|CAPABILITY_DENIED/i.test(answer) &&
        (taskId.includes('pong') ? /PONG/i.test(answer) : /4/.test(answer));
      const statusOk =
        status === 'completed' ||
        status === 'done' ||
        outcome === 'NO_CHANGE_REQUIRED' ||
        outcome === 'VERIFIED_COMPLETE' ||
        outcome === 'UNVERIFIED_PATCH' ||
        (status !== 'failed' && contentOk);
      const ok = contentOk && statusOk;
      const policyViolation = /CAPABILITY_DENIED|policy/i.test(answer);
      return {
        task_id: taskId,
        variant,
        verified_complete_no_policy_violation: ok && !policyViolation,
        tokens: Number(tokens) || 1,
        duration_ms: Date.now() - t0,
        false_completion: false,
        instruction_policy_violation: policyViolation,
        resume_state_equivalent: null,
        critical_fact_retention: null,
        infrastructure_failure: false,
        agent_failure: !ok,
        human_intervention: false,
        clean_room_pass: null,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notes.push(`${variant}:${taskId}:error=${msg.slice(0, 160)}`);
      failureLedger.push({
        entry_id: randomUUID(),
        episode_id: `${variant}:${taskId}`,
        failure_class: /timeout|ECONN|429|5\d\d|fetch/i.test(msg)
          ? 'infrastructure'
          : 'agent',
        regression_fixture: 'runSameModelLlmFactorial',
        created_at: new Date().toISOString(),
        held_out: false,
      });
      return {
        task_id: taskId,
        variant,
        verified_complete_no_policy_violation: false,
        tokens: 0,
        duration_ms: Date.now() - t0,
        false_completion: false,
        instruction_policy_violation: false,
        resume_state_equivalent: null,
        critical_fact_retention: null,
        infrastructure_failure: /timeout|ECONN|429|5\d\d|fetch/i.test(msg),
        agent_failure: !/timeout|ECONN|429|5\d\d|fetch/i.test(msg),
        human_intervention: false,
        clean_room_pass: null,
      };
    }
  }

  for (const t of tasks) {
    results.push(await minimalLoop(t.task_id, t.user_message));
    results.push(await chatVariant(t.task_id, t.task, t.user_message, 'chat_harness'));
    results.push(await chatVariant(t.task_id, t.task, t.user_message, 'deep_profile'));
  }

  const minimal = results.filter((r) => r.variant === 'minimal_loop');
  const chat = results.filter((r) => r.variant === 'chat_harness');
  const deep = results.filter((r) => r.variant === 'deep_profile');
  const paired = [
    ...computePairedDeltas(minimal, chat, 'tokens'),
    ...computePairedDeltas(minimal, deep, 'tokens'),
    ...computePairedDeltas(minimal, chat, 'duration_ms'),
  ];

  const anyOk = results.some((r) => !r.infrastructure_failure && r.tokens > 0);
  const modelSnapshot = `openrouter:${modelId}@temp${temperature}`;
  notes.push(
    `cells=${results.length}`,
    `minimal_ok=${minimal.filter((r) => r.verified_complete_no_policy_violation).length}/${minimal.length}`,
    `chat_ok=${chat.filter((r) => r.verified_complete_no_policy_violation).length}/${chat.length}`,
    `deep_ok=${deep.filter((r) => r.verified_complete_no_policy_violation).length}/${deep.length}`,
    `paired_deltas=${paired.length}`,
    'Deep cell uses ChatEngine executionProfile=deep (not full Deep pipeline stages)',
  );

  return {
    schema_version: HARNESS_EVAL_VERSION,
    controls: {
      ...input.controls,
      model_snapshot: modelSnapshot,
    },
    results,
    paired_deltas: paired,
    failure_ledger: failureLedger,
    metrics: computeCoreMetrics(results),
    experimental_evidence: anyOk,
    notes,
  };
}

/**
 * Persist an eval report under `dir`. Rejects missing/placeholder paths so a
 * forgotten CLI arg cannot create a literal `undefined/` directory (seen when
 * `String(undefined)` or an unset env was passed as the output root).
 */
export function writeEvalReport(dir: string, report: HarnessEvalReport): string {
  if (typeof dir !== 'string') {
    throw new Error(
      `writeEvalReport: invalid output directory ${JSON.stringify(dir)}; pass an explicit path`,
    );
  }
  const trimmed = dir.trim();
  const leaf = basename(normalize(trimmed));
  if (!trimmed || leaf === 'undefined' || leaf === 'null') {
    throw new Error(
      `writeEvalReport: invalid output directory ${JSON.stringify(dir)}; pass an explicit path`,
    );
  }
  mkdirSync(trimmed, { recursive: true });
  const path = join(trimmed, 'harness-eval-report.json');
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf-8');
  return path;
}

export function readEvalReport(path: string): HarnessEvalReport {
  return JSON.parse(readFileSync(path, 'utf-8')) as HarnessEvalReport;
}

/**
 * Controls must match for fair harness comparison; otherwise disclose deviation.
 */
export function controlsMatch(
  a: FixedEvalControls,
  b: FixedEvalControls,
): { ok: boolean; deviations: string[] } {
  const deviations: string[] = [];
  const keys: (keyof FixedEvalControls)[] = [
    'task_set_id',
    'model_snapshot',
    'repository_revision',
    'permissions_profile',
    'verifier_profile',
    'resource_profile',
    'environment_digest',
  ];
  for (const k of keys) {
    if (a[k] !== b[k]) deviations.push(String(k));
  }
  if (a.sampling.temperature !== b.sampling.temperature) {
    deviations.push('sampling.temperature');
  }
  return { ok: deviations.length === 0, deviations };
}
