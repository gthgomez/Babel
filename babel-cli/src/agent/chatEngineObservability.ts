/**
 * Thin observability helpers for ChatEngine terminal payloads (Tier A).
 * Keeps size pressure off chatEngine.ts — prefer growing this module.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from './chatToolDefinitions.js';
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js';
import { DeepSeekApiRunner } from '../runners/deepSeekApi.js';
import { OllamaApiRunner } from '../runners/ollamaApi.js';
import { OpenRouterApiRunner } from '../runners/openRouterApi.js';
import { globalCostTracker, type SessionUsageSummary } from '../services/costTracker.js';
import type { BlockedReport, TerminalOutcome } from '../schemas/agentContracts.js';
import type { ProviderMessage, ProviderToolCall } from '../runners/base.js';
import type { ChatToolAction } from './chatToolDefinitions.js';
import { chatActionToolName } from './chatToolDefinitions.js';
import { isOfflineChatMode } from './chatModelPolicy.js';
import {
  LIVE_OPENROUTER_BACKEND_KEY,
  LIVE_OPENROUTER_MODEL_ID,
  assertLiveModelId,
  resolveOpenRouterDeepSeekModelId,
} from '../modelPolicy.js';
import type { DiffCriticVerdict } from './diffCritic.js';
import { computeToolCallAggregates, type ToolCallAggregates } from './toolCallExport.js';
import type { PolicyEvent, PolicyEventKind, PolicyEventLog } from './policyEventLog.js';
import type { ObservationTailBuffer, ObservationTailEntry } from './observationTails.js';
import type {
  ChatPhase,
  TurnRoutingReceipt,
  TurnRoutingReceiptLog,
} from './turnRoutingReceipt.js';
import {
  deriveEffortAliased,
  mapCostPrecisionToBasis,
  resolveEffectiveEffortSource,
  summarizeCellCost,
  summarizeCellEffort,
} from './turnRoutingReceipt.js';
import type { BlockedAttempt, BlockedAttemptLedger } from './blockedAttemptLedger.js';
import type { TurnSummary, TurnSummaryStore, SummaryCompletionHook } from './turnSummaryScheduler.js';
import {
  TurnSummaryStore as TurnSummaryStoreClass,
  shouldRequestTurnSummary,
  resolveSummaryInterval,
  shouldSkipForBudget,
} from './turnSummaryScheduler.js';
import {
  buildPromptFingerprint,
  type PromptFingerprint,
} from './promptFingerprint.js';

export type { PromptFingerprint };
export { buildPromptFingerprint };

/** B4: Module-level fingerprint stash so chatEngine.ts stays under size ratchet. */
const _fpByRunDir = new Map<string, PromptFingerprint>();
/** Idempotent stash — no-op if a fingerprint is already stored for this runDir. */
export function stashEngineFingerprint(runDir: string, fp: PromptFingerprint): void {
  if (!_fpByRunDir.has(runDir)) _fpByRunDir.set(runDir, fp);
}
function lookupFingerprint(runDir: string): PromptFingerprint | undefined {
  return _fpByRunDir.get(runDir);
}

/** B2: Module-level turn summary store stash — keeps chatEngine.ts under size ratchet. */
const _summaryStoreByRunDir = new Map<string, TurnSummaryStore>();
export function getEngineTurnSummaryStore(runDir: string): TurnSummaryStore {
  let store = _summaryStoreByRunDir.get(runDir);
  if (!store) {
    store = new TurnSummaryStoreClass();
    _summaryStoreByRunDir.set(runDir, store);
  }
  return store;
}
export function clearEngineTurnSummaryStore(runDir: string): void {
  _summaryStoreByRunDir.get(runDir)?.clear();
}

/**
 * B2: Check if a turn summary should fire and optionally invoke a completion hook.
 * Called after tool execution from both submit + stream paths via
 * recordTurnToolObservability — zero chatEngine.ts lines.
 *
 * When no summaryCompletionHook is provided, the scheduler still resolves and
 * the budget gate checks, but no summary is stored (no-op safe). Wire a hook
 * later to capture real model summaries.
 */
export async function maybeRequestTurnSummary(
  h: ObservabilityHandles,
  summaryCompletionHook?: SummaryCompletionHook | null,
): Promise<void> {
  const K = resolveSummaryInterval();
  if (!shouldRequestTurnSummary(h.turnIndex, K)) return;

  const spent = globalCostTracker.getSessionSummary().totalCostUSD;
  const limitRaw = process.env['BABEL_CHAT_MAX_COST_USD'];
  const limit = limitRaw ? Number(limitRaw) : 0;
  if (shouldSkipForBudget(limit, spent)) return;

  if (!summaryCompletionHook) return; // no-op stub — hook not wired yet

  const prompt = (await import('./turnSummaryScheduler.js')).buildSummaryRequestPrompt(h.turnIndex);
  const summary = await summaryCompletionHook(h.turnIndex, prompt);
  if (summary) {
    getEngineTurnSummaryStore(h.engineRunDir).push(summary);
  }
}

export type ToolCallLogEntry = {
  tool: string;
  target: string;
  detail?: string;
  error?: string;
  index: number;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  verified?: boolean;
};

/** Payload shape shared with ChatEvent done/failed (exactOptionalPropertyTypes-safe). */
export type ExportedToolCall = {
  tool: string;
  target: string;
  detail?: string;
  error?: string;
  /** Stable log order index (for harness logIndexToTurn reconstruction). */
  index?: number;
  /** Chat turn that executed this tool (from engine logIndexToTurn). */
  turn?: number;
  exit_code?: number;
};

export type StreamDoneEvent = {
  type: 'done';
  answer: string;
  usage: SessionUsageSummary;
  toolCalls: ExportedToolCall[];
  runDir: string;
  /** Authoritative terminal outcome from the engine (P0-D lossless). */
  outcome: TerminalOutcome;
  planOutcome?: 'PLAN_COMPLETE';
  /** True when wall/cost/token budget forced termination. */
  budgetExceeded?: boolean;
  verifierReceipt?: { command: string; exit_code: number; summary: string } | null;
  blockedReport?: BlockedReport | null;
  verifierTampered?: boolean;
  criticReceipt?: DiffCriticVerdict | null;
  policyEvents?: PolicyEvent[];
  turnRouting?: TurnRoutingReceipt[];
  observationTails?: ObservationTailEntry[];
  blockedAttempts?: BlockedAttempt[];
  turnSummaries?: TurnSummary[];
  turnTelemetry?: import('./chatTurnTelemetry.js').ChatTurnTelemetryRecord;
};

export type StreamFailedEvent = {
  type: 'failed';
  error: string;
  toolCalls: ExportedToolCall[];
  runDir?: string;
  turnTelemetry?: import('./chatTurnTelemetry.js').ChatTurnTelemetryRecord;
};

export interface ObservabilityHandles {
  toolCallLog: ToolCallLogEntry[];
  engineRunDir: string;
  lastVerifierReceipt?: { command: string; exit_code: number; summary: string } | null;
  policyEventLog: PolicyEventLog;
  routingReceiptLog: TurnRoutingReceiptLog;
  observationTails: ObservationTailBuffer;
  blockedAttemptLedger: BlockedAttemptLedger;
  logIndexToTurn: Map<number, number>;
  turnIndex: number;
  turnToolCallLogStart: number;
  lastPhase: ChatPhase;
}

/** Map new tool log rows to the current turn and capture observation tails.
 *  Also derives blocked-attempt ledger entries (Tier B3). */
export function recordTurnToolObservability(h: ObservabilityHandles): void {
  for (let li = h.turnToolCallLogStart; li < h.toolCallLog.length; li++) {
    h.logIndexToTurn.set(li, h.turnIndex);
    const tc = h.toolCallLog[li]!;
    const obsText = [tc.stdout ?? '', tc.stderr ?? ''].filter(Boolean).join('\n');
    if (obsText.trim()) {
      h.observationTails.record(tc.tool, tc.target, obsText, tc.exit_code);
    }
  }
  syncBlockedAttemptsFromToolLog(h, h.turnToolCallLogStart);
  void maybeRequestTurnSummary(h); // B2: fire-and-forget turn summary check
}

export function recordPolicyEvent(
  log: PolicyEventLog,
  turn: number,
  kind: PolicyEventKind,
  detail?: string,
  tool?: string,
): void {
  log.record({
    at_turn: turn,
    kind,
    ...(detail !== undefined ? { detail } : {}),
    ...(tool !== undefined ? { tool } : {}),
  });
}

/**
 * Export tool calls with turn binding for TTF-write / thrash metrics.
 * Prefer turn+index over legacy strip-only export so campaigns can compute
 * turns_to_first_write without replaying the engine.
 */
export function exportToolCallsWithTurns(
  log: ToolCallLogEntry[],
  logIndexToTurn?: ReadonlyMap<number, number>,
): ExportedToolCall[] {
  return log.map((entry) => {
    const turn = logIndexToTurn?.get(entry.index);
    const out: ExportedToolCall = {
      tool: entry.tool,
      target: entry.target,
      index: entry.index,
    };
    if (entry.detail !== undefined) out.detail = entry.detail;
    if (entry.error !== undefined) out.error = entry.error;
    if (entry.exit_code !== undefined) out.exit_code = entry.exit_code;
    if (turn !== undefined) out.turn = turn;
    return out;
  });
}

function exportToolCalls(
  log: ToolCallLogEntry[],
  logIndexToTurn?: ReadonlyMap<number, number>,
): ExportedToolCall[] {
  if (logIndexToTurn && logIndexToTurn.size > 0) {
    return exportToolCallsWithTurns(log, logIndexToTurn);
  }
  // Fallback: still keep index so harness can recover order even without turn map
  return exportToolCallsWithTurns(log);
}

export function buildStreamDone(
  h: ObservabilityHandles,
  answer: string,
  extra?: {
    outcome: TerminalOutcome;
    planOutcome?: 'PLAN_COMPLETE';
    budgetExceeded?: boolean;
    blockedReport?: BlockedReport | null;
    verifierTampered?: boolean;
    criticReceipt?: DiffCriticVerdict | null;
    turnTelemetry?: import('./chatTurnTelemetry.js').ChatTurnTelemetryRecord;
  },
): StreamDoneEvent {
  if (!extra?.outcome) {
    throw new Error('buildStreamDone requires an authoritative TerminalOutcome (P0-D)');
  }
  const event: StreamDoneEvent = {
    type: 'done',
    answer,
    usage: globalCostTracker.getSessionSummary(),
    toolCalls: exportToolCalls(h.toolCallLog, h.logIndexToTurn),
    runDir: h.engineRunDir,
    outcome: extra.outcome,
    verifierReceipt: h.lastVerifierReceipt ?? null,
    policyEvents: h.policyEventLog.last(50),
    turnRouting: h.routingReceiptLog.toJSON(),
    observationTails: h.observationTails.toJSON(),
    blockedAttempts: h.blockedAttemptLedger.toJSON(),
    turnSummaries: getEngineTurnSummaryStore(h.engineRunDir).toJSON(),
  };
  if (extra.budgetExceeded) event.budgetExceeded = true;
  if (extra.blockedReport !== undefined) event.blockedReport = extra.blockedReport;
  if (extra.verifierTampered) event.verifierTampered = true;
  if (extra.criticReceipt) event.criticReceipt = extra.criticReceipt;
  if (extra.planOutcome) event.planOutcome = extra.planOutcome;
  if (extra.turnTelemetry) event.turnTelemetry = extra.turnTelemetry;
  return event;
}

export function buildStreamFailed(
  h: ObservabilityHandles,
  error: string,
  extra?: { turnTelemetry?: import('./chatTurnTelemetry.js').ChatTurnTelemetryRecord },
): StreamFailedEvent {
  const event: StreamFailedEvent = {
    type: 'failed',
    error,
    toolCalls: exportToolCalls(h.toolCallLog),
  };
  if (h.engineRunDir) event.runDir = h.engineRunDir;
  if (extra?.turnTelemetry) event.turnTelemetry = extra.turnTelemetry;
  return event;
}

export function observabilityResultFields(h: ObservabilityHandles): {
  toolCalls: ExportedToolCall[];
  policyEvents: PolicyEvent[];
  turnRouting: TurnRoutingReceipt[];
  observationTails: ObservationTailEntry[];
  toolCallAggregates: ToolCallAggregates;
  blockedAttempts: BlockedAttempt[];
  blockedAttemptCounts: { total: number; byReason: Record<string, number> };
  turnSummaries: TurnSummary[];
} {
  const fp = lookupFingerprint(h.engineRunDir);
  return {
    toolCalls: exportToolCalls(h.toolCallLog, h.logIndexToTurn),
    policyEvents: h.policyEventLog.last(50),
    turnRouting: h.routingReceiptLog.toJSON(),
    observationTails: h.observationTails.toJSON(),
    toolCallAggregates: computeToolCallAggregates(h.toolCallLog),
    blockedAttempts: h.blockedAttemptLedger.toJSON(),
    blockedAttemptCounts: h.blockedAttemptLedger.countsByReason(),
    turnSummaries: getEngineTurnSummaryStore(h.engineRunDir).toJSON(),
    ...(fp ? { promptFingerprint: fp } : {}),
  };
}

/**
 * Metadata accepted from runner.getLastInvocationMetadata().
 * Effort fields must not be dropped (Slice 2 causal telemetry).
 */
export type RoutingReceiptMetadata = {
  provider_model_id?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  estimated_cost_usd?: number | null;
  prompt_cache_hit_tokens?: number | null;
  prompt_cache_miss_tokens?: number | null;
  cost_precision?: string | null;
  pricing_source_url?: string | null;
  pricing_verified_at?: string | null;
  requested_model_id?: string | null;
  normalized_model_id?: string | null;
  sent_model_id?: string | null;
  observed_model_id?: string | null;
  requested_reasoning_effort?: string | null;
  normalized_reasoning_effort?: string | null;
  sent_reasoning_effort?: string | null;
  observed_reasoning_effort?: string | null;
};

export function pushRoutingReceiptFromMetadata(
  log: TurnRoutingReceiptLog,
  turn: number,
  phase: ChatPhase,
  metadata: RoutingReceiptMetadata,
): void {
  if (
    !metadata.provider_model_id ||
    metadata.prompt_tokens == null ||
    metadata.completion_tokens == null
  ) {
    return;
  }

  const requested = metadata.requested_reasoning_effort ?? null;
  const normalized = metadata.normalized_reasoning_effort ?? null;
  const sent = metadata.sent_reasoning_effort ?? null;
  const observed = metadata.observed_reasoning_effort ?? null;
  const { source: effective_source } = resolveEffectiveEffortSource({
    requested,
    normalized,
    sent,
    observed,
  });
  const effort_aliased = deriveEffortAliased(requested, sent, normalized);
  const cost_basis = mapCostPrecisionToBasis(metadata.cost_precision);

  const receipt: TurnRoutingReceipt = {
    turn,
    phase,
    model: metadata.provider_model_id,
    input_tokens: metadata.prompt_tokens,
    output_tokens: metadata.completion_tokens,
    cost_usd: metadata.estimated_cost_usd ?? 0,
    cost_basis,
    effective_source,
    effort_aliased,
  };

  if (metadata.prompt_cache_hit_tokens != null) {
    receipt.cache_hit_tokens = metadata.prompt_cache_hit_tokens;
  }
  if (metadata.prompt_cache_miss_tokens != null) {
    receipt.cache_miss_tokens = metadata.prompt_cache_miss_tokens;
  }
  if (metadata.pricing_verified_at != null) {
    receipt.pricing_verified_at = metadata.pricing_verified_at;
  }
  if (metadata.pricing_source_url != null) {
    receipt.pricing_source_url = metadata.pricing_source_url;
  }
  if (metadata.cost_precision != null) {
    receipt.cost_precision = metadata.cost_precision;
  }
  if (metadata.requested_model_id != null) {
    receipt.requested_model_id = metadata.requested_model_id;
  }
  if (metadata.normalized_model_id != null) {
    receipt.normalized_model_id = metadata.normalized_model_id;
  }
  if (metadata.sent_model_id != null) {
    receipt.sent_model_id = metadata.sent_model_id;
  }
  if (metadata.observed_model_id != null) {
    receipt.observed_model_id = metadata.observed_model_id;
  }
  if (requested != null) receipt.requested_reasoning_effort = requested;
  if (normalized != null) receipt.normalized_reasoning_effort = normalized;
  if (sent != null) receipt.sent_reasoning_effort = sent;
  if (observed != null) receipt.observed_reasoning_effort = observed;

  log.push(receipt);
}

// ── Harness boundary counters (Slice 2) ───────────────────────────────────────

/** Stable cell-level counters for thrash / suppression diagnosis. */
export interface HarnessBoundaryCounters {
  mutation_intent_count: number;
  tool_parse_reject_count: number;
  tool_parse_repair_count: number;
  tool_alias_normalize_count: number;
  arg_validation_fail_count: number;
  policy_deny_count: number;
  tool_dispatch_count: number;
  write_apply_count: number;
  write_receipt_count: number;
  git_patch_count: number;
  verifier_authority_count: number;
  progress_controller_count: number;
  budget_arbitration_count: number;
  /** Legacy/policy kinds that deny or restrict mutations */
  force_mutate_count: number;
  force_mutate_shadow_count: number;
  zero_write_hard_stop_count: number;
  zero_write_shadow_count: number;
  phase_gate_block_count: number;
  /** Derived from tool log */
  successful_write_tool_count: number;
  denied_or_failed_write_tool_count: number;
  verifier_attempt_tool_count: number;
  turns_to_first_mutation_intent: number | null;
  turns_to_first_applied_write: number | null;
}

const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'str_replace',
  'apply_patch',
  'create_file',
  'delete_file',
  'multi_edit',
]);

const VERIFIER_TOOLS = new Set([
  'run_tests',
  'run_command',
  'bash',
  'shell',
]);

function countKind(
  events: ReadonlyArray<{ kind?: string; at_turn?: number }>,
  kind: string,
): number {
  return events.filter((e) => e.kind === kind).length;
}

function firstTurnOfKind(
  events: ReadonlyArray<{ kind?: string; at_turn?: number }>,
  kinds: string[],
): number | null {
  let min: number | null = null;
  for (const e of events) {
    if (!e.kind || !kinds.includes(e.kind)) continue;
    if (typeof e.at_turn !== 'number') continue;
    if (min == null || e.at_turn < min) min = e.at_turn;
  }
  return min;
}

/**
 * Compute harness-boundary counters from policy events + tool call log.
 * Maps both new Slice-2 kinds and legacy policy kinds so thrash is classifiable
 * even before every emit site is upgraded.
 */
export function computeHarnessBoundaryCounters(input: {
  policyEvents?: ReadonlyArray<{ kind?: string; at_turn?: number; detail?: string }>;
  toolCalls?: ReadonlyArray<{
    tool?: string;
    error?: string;
    exit_code?: number;
    index?: number;
    turn?: number;
  }>;
  /** Optional turn index per tool log entry (from ObservabilityHandles.logIndexToTurn). */
  logIndexToTurn?: ReadonlyMap<number, number>;
}): HarnessBoundaryCounters {
  const events = input.policyEvents ?? [];
  const tools = input.toolCalls ?? [];

  let successful_write_tool_count = 0;
  let denied_or_failed_write_tool_count = 0;
  let verifier_attempt_tool_count = 0;
  let turns_to_first_applied_write: number | null = null;

  for (let i = 0; i < tools.length; i += 1) {
    const tc = tools[i]!;
    const name = (tc.tool ?? '').toLowerCase();
    const isWrite = WRITE_TOOLS.has(name) || name.includes('write') || name.includes('edit') || name.includes('patch');
    const isVerifier =
      VERIFIER_TOOLS.has(name) ||
      name.includes('test') ||
      name.includes('pytest') ||
      name.includes('verify');
    const failed = Boolean(tc.error) || (tc.exit_code != null && tc.exit_code !== 0);

    if (isWrite) {
      if (failed) denied_or_failed_write_tool_count += 1;
      else {
        successful_write_tool_count += 1;
        // Prefer explicit tool.turn (headless JSON), then logIndexToTurn map, then index-as-order fallback
        const turn =
          typeof tc.turn === 'number'
            ? tc.turn
            : input.logIndexToTurn?.get(tc.index ?? i) ??
              input.logIndexToTurn?.get(i) ??
              null;
        if (turn != null && (turns_to_first_applied_write == null || turn < turns_to_first_applied_write)) {
          turns_to_first_applied_write = turn;
        }
      }
    }
    if (isVerifier) verifier_attempt_tool_count += 1;
  }

  // Mutation intent: explicit kind or first write-class tool attempt
  const mutation_intent_count =
    countKind(events, 'mutation_intent') +
    tools.filter((t) => {
      const name = (t.tool ?? '').toLowerCase();
      return WRITE_TOOLS.has(name) || name.includes('write') || name.includes('edit') || name.includes('patch');
    }).length;

  const turns_to_first_mutation_intent =
    firstTurnOfKind(events, ['mutation_intent']) ??
    turns_to_first_applied_write;

  return {
    mutation_intent_count,
    tool_parse_reject_count: countKind(events, 'tool_parse_reject'),
    tool_parse_repair_count: countKind(events, 'tool_parse_repair'),
    tool_alias_normalize_count: countKind(events, 'tool_alias_normalize'),
    arg_validation_fail_count: countKind(events, 'arg_validation_fail'),
    policy_deny_count:
      countKind(events, 'policy_deny') +
      countKind(events, 'phase_gate_block') +
      countKind(events, 'plan_gate_block'),
    tool_dispatch_count: countKind(events, 'tool_dispatch') + tools.length,
    write_apply_count: countKind(events, 'write_apply') + successful_write_tool_count,
    write_receipt_count: countKind(events, 'write_receipt'),
    git_patch_count: countKind(events, 'git_patch'),
    verifier_authority_count: countKind(events, 'verifier_authority'),
    progress_controller_count:
      countKind(events, 'progress_controller') +
      countKind(events, 'progress_policy') +
      countKind(events, 'progress_terminal'),
    budget_arbitration_count:
      countKind(events, 'budget_arbitration') +
      countKind(events, 'budget_kill') +
      countKind(events, 'token_explosion'),
    force_mutate_count: countKind(events, 'force_mutate'),
    force_mutate_shadow_count: countKind(events, 'force_mutate_shadow'),
    zero_write_hard_stop_count: countKind(events, 'zero_write_hard_stop'),
    zero_write_shadow_count: countKind(events, 'zero_write_shadow'),
    phase_gate_block_count: countKind(events, 'phase_gate_block'),
    successful_write_tool_count,
    denied_or_failed_write_tool_count,
    verifier_attempt_tool_count,
    turns_to_first_mutation_intent,
    turns_to_first_applied_write,
  };
}

/**
 * Build cell telemetry bundle from session observability (effort + cost + boundary).
 */
export function buildCellTelemetryBundle(input: {
  turnRouting: ReadonlyArray<TurnRoutingReceipt>;
  policyEvents?: ReadonlyArray<{ kind?: string; at_turn?: number; detail?: string }>;
  toolCalls?: ReadonlyArray<{
    tool?: string;
    error?: string;
    exit_code?: number;
    index?: number;
    turn?: number;
  }>;
  logIndexToTurn?: ReadonlyMap<number, number>;
}): {
  effort: ReturnType<typeof summarizeCellEffort>;
  cost: ReturnType<typeof summarizeCellCost>;
  boundary: HarnessBoundaryCounters;
} {
  return {
    effort: summarizeCellEffort(input.turnRouting),
    cost: summarizeCellCost(input.turnRouting),
    boundary: computeHarnessBoundaryCounters({
      ...(input.policyEvents !== undefined ? { policyEvents: input.policyEvents } : {}),
      ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
      ...(input.logIndexToTurn !== undefined ? { logIndexToTurn: input.logIndexToTurn } : {}),
    }),
  };
}

/**
 * Persist policy events to runDir/policy-events.jsonl.
 *
 * **Synchronous on purpose**: headless CLI exits immediately after printing
 * JSON. An async fire-and-forget write races process exit and left Phase-2
 * shadow campaigns with empty scoreboards (run_dir present, 0-byte/missing
 * policy-events.jsonl). Callers must not treat this as best-effort async I/O.
 */
export function persistPolicyEventsJsonl(
  runDir: string,
  log: PolicyEventLog,
): void {
  const jsonl = log.toJSONL();
  if (!jsonl) return;
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'policy-events.jsonl'), jsonl, 'utf-8');
}

/**
 * Derive blocked attempts from the tool call log by scanning entries with known
 * error/detail markers. Called once per turn after tool execution so
 * chatEngine.ts stays under the size ratchet.
 */
export function syncBlockedAttemptsFromToolLog(
  h: ObservabilityHandles,
  startIndex: number,
): void {
  for (let li = startIndex; li < h.toolCallLog.length; li++) {
    const tc = h.toolCallLog[li]!;
    const turn = h.logIndexToTurn.get(li) ?? h.turnIndex;

    // plan-gate block (todo-before-mutate OR hard-plan mode)
    if (
      tc.error === 'blocked' &&
      (tc.detail === 'plan-gate' || tc.detail === 'hard-plan-mode')
    ) {
      h.blockedAttemptLedger.record({
        turn,
        tool: tc.tool,
        target: tc.target,
        reason: 'plan-gate',
        ...(tc.detail === 'hard-plan-mode' ? { detail: 'hard-plan-mode' } : {}),
      });
      continue;
    }
    // phase-gate block
    if (tc.error === 'blocked' && tc.detail === 'phase-gate') {
      h.blockedAttemptLedger.record({ turn, tool: tc.tool, target: tc.target, reason: 'phase-gate' });
      continue;
    }
    // policy restrict block (error === 'blocked' but not plan/phase gate)
    if (tc.error === 'blocked') {
      h.blockedAttemptLedger.record({ turn, tool: tc.tool, target: tc.target, reason: 'policy' });
      continue;
    }
    // str_replace miss
    if (tc.error && tc.error.startsWith('str_replace:')) {
      h.blockedAttemptLedger.record({ turn, tool: tc.tool, target: tc.target, reason: 'str_replace_miss', detail: tc.error });
      continue;
    }
    // path errors: read_range start_line out of range
    if (tc.error === 'start_line out of range') {
      h.blockedAttemptLedger.record({ turn, tool: tc.tool, target: tc.target, reason: 'path', detail: tc.error });
      continue;
    }
  }
}

/**
 * C1: Persist the compiled intent plan to run_dir/intent_plan.json.
 * Fire-and-forget — never throws, failure is silent (the plan was already
 * injected into the conversation).
 */
export async function persistIntentPlan(
  runDir: string,
  plan: { goal: string; success_criteria: string[]; likely_files: string[]; test_command?: string; constraints: string[]; confidence: number },
): Promise<void> {
  try {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(runDir, { recursive: true });
    const payload = {
      schema: 'intent_plan/1',
      ...plan,
      test_command: plan.test_command ?? null,
    };
    await writeFile(join(runDir, 'intent_plan.json'), JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // best-effort — the plan is already in the conversation
  }
}

// ─── TerminalOutcome computation ───────────────────────────────────

/** True when a blocked-report reason is host env / toolchain (not policy thrash). */
export function isEnvBlockedReportReason(reason: string | null | undefined): boolean {
  if (!reason?.trim()) return false;
  const r = reason.toLowerCase();
  return (
    /\benv_blocked\b/.test(r) ||
    /\benvironment\s*\/\s*toolchain\b/.test(r) ||
    /\benvironment cannot\b/.test(r) ||
    /\bworking project runtime\b/.test(r) ||
    /\bmissing dep\b/.test(r) ||
    /\bimporterror\b/.test(r) ||
    /\bmodulenotfound\b/.test(r) ||
    /\bwhile loading conftest\b/.test(r) ||
    /\bhost toolchain\b/.test(r) ||
    /\bcannot run verification\b/.test(r) ||
    // buildPolicyTerminalBlockedReport('env_blocked') reason
    /\bdeps installed\b/.test(r) ||
    /\bconftest importable\b/.test(r)
  );
}

/** True when blocked/verify text is pytest collect/import failure (not assert fail). */
export function isVerifierCollectErrorText(text: string | null | undefined): boolean {
  if (!text?.trim()) return false;
  const t = text.toLowerCase();
  return (
    /\bwhile loading conftest\b/.test(t) ||
    /\berror collecting\b/.test(t) ||
    (/\b(modulenotfounderror|importerror|no module named)\b/.test(t) &&
      (/\bconftest\b/.test(t) || /\bpytest\b/.test(t) || /\bcollect\b/.test(t))) ||
    (/\bno tests (ran|collected)\b/.test(t) &&
      /\b(modulenotfounderror|importerror|no module named)\b/.test(t))
  );
}

/** Pure function: map final session state to honest TerminalOutcome.
 *  Extracted from ChatEngine.buildResult to keep chatEngine.ts under size ratchet. */
export function computeTerminalOutcome(input: {
  finalStatus: string;
  budgetExceeded: boolean;
  lastVerifierReceipt?: { exit_code: number; command?: string; summary?: string } | null | undefined;
  blockedReport?: { reason: string; missing?: string } | null | undefined;
  /** W1 C: production writes present — collect fail is failed-with-evidence, not pure env. */
  hasAnyWrites?: boolean;
}): TerminalOutcome {
  if (input.budgetExceeded || input.finalStatus === 'budget_exhausted') {
    return 'BUDGET_EXHAUSTED';
  }
  // Explicit env terminal status (product / harness may surface this)
  if (
    input.finalStatus === 'env_blocked' ||
    input.finalStatus === 'ENV_BLOCKED'
  ) {
    return 'BLOCKED_EXTERNAL';
  }
  switch (input.finalStatus) {
    case 'completed':
      return (input.lastVerifierReceipt && input.lastVerifierReceipt.exit_code === 0)
        ? 'VERIFIED_COMPLETE'
        : 'UNVERIFIED_PATCH';
    case 'blocked': {
      const reason = input.blockedReport?.reason ?? '';
      const missing = input.blockedReport?.missing ?? '';
      const envBlob = `${reason}\n${missing}`;
      const receiptBlob = [
        input.lastVerifierReceipt?.command,
        input.lastVerifierReceipt?.summary,
        input.lastVerifierReceipt?.exit_code != null
          ? `exit ${input.lastVerifierReceipt.exit_code}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      // W1 C: after production patch, collect/import verify fail → AGENT_FAILURE
      // (failed-with-evidence / verifier_red class) — not BLOCKED_EXTERNAL thrash.
      if (
        input.hasAnyWrites &&
        (isVerifierCollectErrorText(envBlob) ||
          isVerifierCollectErrorText(receiptBlob) ||
          (input.lastVerifierReceipt != null &&
            input.lastVerifierReceipt.exit_code !== 0 &&
            isVerifierCollectErrorText(
              `${input.lastVerifierReceipt.command ?? ''}\n${input.lastVerifierReceipt.summary ?? ''}`,
            )))
      ) {
        return 'AGENT_FAILURE';
      }
      // Env/toolchain blocks are external (host), not policy thrash — check first
      // so "cannot run verification" in the ENV_BLOCKED reason does not mislabel.
      // After writes, import-class env reasons without host-toolchain still map external
      // only when they are true pre-mutate env; collect-after-write handled above.
      if (isEnvBlockedReportReason(envBlob) || isEnvBlockedReportReason(reason)) {
        if (input.hasAnyWrites && isVerifierCollectErrorText(envBlob)) {
          return 'AGENT_FAILURE';
        }
        return 'BLOCKED_EXTERNAL';
      }
      // Distinguish policy blocks (critic, gate, auto-continue, tamper,
      // zero-write, investigate hard cap) from other external blocks.
      // Avoid bare "verification" matching ENV_BLOCKED copy — env already handled.
      if (
        /auto.continue|investigate.?hard.?cap|zero.?write|tamper|critic|phase.?gate|completion.?gate|progress.?terminal|stall.?kill|circuit.?breaker|explicit.?deny|policy/i.test(
          reason,
        ) ||
        /verifier honesty|green verifier|gate reject/i.test(reason)
      ) {
        // W1 C: completion-gate verifier_red on collect after patch → evidence fail
        if (
          input.hasAnyWrites &&
          /verifier honesty|green verifier|gate reject|verifier_red/i.test(reason) &&
          isVerifierCollectErrorText(envBlob + receiptBlob)
        ) {
          return 'AGENT_FAILURE';
        }
        return 'BLOCKED_POLICY';
      }
      return 'BLOCKED_EXTERNAL';
    }
    case 'cancelled':
      return 'CANCELLED';
    case 'failed':
      return 'AGENT_FAILURE';
  }
  return 'AGENT_FAILURE';
}

// ─── Provider conversation population ──────────────────────────────

/** Push assistant + tool messages to the structured provider conversation.
 *  Extracted from ChatEngine (duplicated in submitMessage + submitMessageStream)
 *  to keep chatEngine.ts under size ratchet. Mutates `conversation` in place. */
/**
 * Push assistant + tool messages to the structured provider conversation.
 * Prefer provider-native tool_call ids when supplied; otherwise synthetic
 * `tool_call_${turnIndex}_${idx}`. Returns the ids used (for event-log parity).
 */
export function pushProviderTurnMessages(input: {
  conversation: ProviderMessage[];
  actions: ChatToolAction[];
  thinking?: string | undefined;
  turnIndex: number;
  /**
   * Aggregated observations (legacy). Prefer `observationsPerTool` so each
   * tool_call_id gets its own tool-result message (P0-B / implementor W0.2).
   */
  observations: string;
  /**
   * Per-action observation text, same order/length as `actions` when provided.
   * When missing or length-mismatched, falls back to a single aggregated tool
   * message on the first id (legacy behavior).
   */
  observationsPerTool?: string[];
  /** Provider-native tool_use ids when available (same length as actions preferred). */
  toolCallIds?: string[];
}): string[] {
  const turnToolCalls: ProviderToolCall[] = input.actions.map((action, idx) => {
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(action)) {
      if (k !== 'type') args[k] = v;
    }
    const id =
      input.toolCallIds?.[idx] && input.toolCallIds[idx]!.length > 0
        ? input.toolCallIds[idx]!
        : `tool_call_${input.turnIndex}_${idx}`;
    return {
      id,
      type: 'function' as const,
      function: {
        name: chatActionToolName(action),
        arguments: JSON.stringify(args),
      },
    };
  });
  input.conversation.push({
    role: 'assistant',
    content: input.thinking ?? 'Using tools…',
    name: 'tool_calls',
    tool_calls: turnToolCalls,
  });
  // One tool-result message per tool_call_id (provider protocol fidelity).
  if (turnToolCalls.length > 0) {
    const perTool = input.observationsPerTool;
    const usePerTool =
      Array.isArray(perTool) &&
      perTool.length === turnToolCalls.length;
    if (usePerTool) {
      for (let i = 0; i < turnToolCalls.length; i++) {
        input.conversation.push({
          role: 'tool',
          content: perTool[i] ?? '',
          tool_call_id: turnToolCalls[i]!.id,
        });
      }
    } else {
      // Legacy: one aggregated message on the first id.
      input.conversation.push({
        role: 'tool',
        content: input.observations,
        tool_call_id: turnToolCalls[0]!.id,
      });
    }
  }
  return turnToolCalls.map((tc) => tc.id);
}

// ─── Runner factory ──────────────────────────────────────────────────────

/** Create the appropriate runner for a model name.
 *  Extracted from ChatEngine._makeRunner to keep chatEngine.ts under size ratchet. */
export function makeChatRunner(
  modelName: string,
): DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner | OpenRouterApiRunner {
  if (!isOfflineChatMode()) assertLiveModelId(modelName, 'live chat phase routing');
  const isDS = modelName.toLowerCase().includes('deepseek');
  const isOL = modelName.toLowerCase().includes('ollama') || modelName.includes(':');
  if (modelName === LIVE_OPENROUTER_MODEL_ID || modelName === LIVE_OPENROUTER_BACKEND_KEY) {
    return new OpenRouterApiRunner(LIVE_OPENROUTER_MODEL_ID);
  }
  const openRouterDeepSeekModel = resolveOpenRouterDeepSeekModelId(modelName);
  if (openRouterDeepSeekModel && !isOfflineChatMode()) {
    return new OpenRouterApiRunner(openRouterDeepSeekModel);
  }
  if (isDS && !isOfflineChatMode()) {
    throw new Error(
      '[LIVE_MODEL_POLICY] Direct DeepSeek live calls are disabled; use the OpenRouter DeepSeek control route.',
    );
  }
  return isOL ? new OllamaApiRunner(modelName)
    : isDS ? new DeepSeekApiRunner(modelName)
    : new DeepInfraApiRunner(modelName);
}

// ─── Transcript persistence ──────────────────────────────────────────────

/** Best-effort transcript persistence to disk.
 *  Extracted from ChatEngine.persistTranscript to keep chatEngine.ts under size ratchet. */
export async function persistTranscriptToDisk(
  runDir: string,
  conversation: ChatMessage[],
): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(runDir, { recursive: true });
  const lines = conversation.map((m) => JSON.stringify(m)).join('\n') + '\n';
  await writeFile(join(runDir, 'transcript.jsonl'), lines, 'utf-8');
}
