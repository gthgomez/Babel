/**
 * Thin observability helpers for ChatEngine terminal payloads (Tier A).
 * Keeps size pressure off chatEngine.ts — prefer growing this module.
 */

import type { ChatMessage } from './chatToolDefinitions.js';
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js';
import { DeepSeekApiRunner } from '../runners/deepSeekApi.js';
import { OllamaApiRunner } from '../runners/ollamaApi.js';
import { globalCostTracker, type SessionUsageSummary } from '../services/costTracker.js';
import type { BlockedReport, TerminalOutcome } from '../schemas/agentContracts.js';
import type { ProviderMessage, ProviderToolCall } from '../runners/base.js';
import type { ChatToolAction } from './chatToolDefinitions.js';
import { chatActionToolName } from './chatToolDefinitions.js';
import type { DiffCriticVerdict } from './diffCritic.js';
import { exportToolCallLog } from './chatZeroWritePolicy.js';
import { computeToolCallAggregates, type ToolCallAggregates } from './toolCallExport.js';
import type { PolicyEvent, PolicyEventKind, PolicyEventLog } from './policyEventLog.js';
import type { ObservationTailBuffer, ObservationTailEntry } from './observationTails.js';
import type {
  ChatPhase,
  TurnRoutingReceipt,
  TurnRoutingReceiptLog,
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
};

export type StreamDoneEvent = {
  type: 'done';
  answer: string;
  usage: SessionUsageSummary;
  toolCalls: ExportedToolCall[];
  runDir: string;
  verifierReceipt?: { command: string; exit_code: number; summary: string } | null;
  blockedReport?: BlockedReport | null;
  verifierTampered?: boolean;
  criticReceipt?: DiffCriticVerdict | null;
  policyEvents?: PolicyEvent[];
  turnRouting?: TurnRoutingReceipt[];
  observationTails?: ObservationTailEntry[];
  blockedAttempts?: BlockedAttempt[];
  turnSummaries?: TurnSummary[];
};

export type StreamFailedEvent = {
  type: 'failed';
  error: string;
  toolCalls: ExportedToolCall[];
  runDir?: string;
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

function exportToolCalls(log: ToolCallLogEntry[]): ExportedToolCall[] {
  return exportToolCallLog(log) as ExportedToolCall[];
}

export function buildStreamDone(
  h: ObservabilityHandles,
  answer: string,
  extra?: {
    blockedReport?: BlockedReport | null;
    verifierTampered?: boolean;
    criticReceipt?: DiffCriticVerdict | null;
  },
): StreamDoneEvent {
  const event: StreamDoneEvent = {
    type: 'done',
    answer,
    usage: globalCostTracker.getSessionSummary(),
    toolCalls: exportToolCalls(h.toolCallLog),
    runDir: h.engineRunDir,
    verifierReceipt: h.lastVerifierReceipt ?? null,
    policyEvents: h.policyEventLog.last(50),
    turnRouting: h.routingReceiptLog.toJSON(),
    observationTails: h.observationTails.toJSON(),
    blockedAttempts: h.blockedAttemptLedger.toJSON(),
    turnSummaries: getEngineTurnSummaryStore(h.engineRunDir).toJSON(),
  };
  if (extra?.blockedReport !== undefined) event.blockedReport = extra.blockedReport;
  if (extra?.verifierTampered) event.verifierTampered = true;
  if (extra?.criticReceipt) event.criticReceipt = extra.criticReceipt;
  return event;
}

export function buildStreamFailed(h: ObservabilityHandles, error: string): StreamFailedEvent {
  const event: StreamFailedEvent = {
    type: 'failed',
    error,
    toolCalls: exportToolCalls(h.toolCallLog),
  };
  if (h.engineRunDir) event.runDir = h.engineRunDir;
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
    toolCalls: exportToolCalls(h.toolCallLog),
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

export function pushRoutingReceiptFromMetadata(
  log: TurnRoutingReceiptLog,
  turn: number,
  phase: ChatPhase,
  metadata: {
    provider_model_id?: string | null;
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    estimated_cost_usd?: number | null;
    prompt_cache_hit_tokens?: number | null;
    prompt_cache_miss_tokens?: number | null;
  },
): void {
  if (
    !metadata.provider_model_id ||
    metadata.prompt_tokens == null ||
    metadata.completion_tokens == null
  ) {
    return;
  }
  log.push({
    turn,
    phase,
    model: metadata.provider_model_id,
    input_tokens: metadata.prompt_tokens,
    output_tokens: metadata.completion_tokens,
    cost_usd: metadata.estimated_cost_usd ?? 0,
    ...(metadata.prompt_cache_hit_tokens != null
      ? { cache_hit_tokens: metadata.prompt_cache_hit_tokens }
      : {}),
    ...(metadata.prompt_cache_miss_tokens != null
      ? { cache_miss_tokens: metadata.prompt_cache_miss_tokens }
      : {}),
  });
}

export async function persistPolicyEventsJsonl(
  runDir: string,
  log: PolicyEventLog,
): Promise<void> {
  const jsonl = log.toJSONL();
  if (!jsonl) return;
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'policy-events.jsonl'), jsonl, 'utf-8');
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

// ─── P0-D: TerminalOutcome computation ───────────────────────────────────

/** Pure function: map final session state to honest TerminalOutcome.
 *  Extracted from ChatEngine.buildResult to keep chatEngine.ts under size ratchet. */
export function computeTerminalOutcome(input: {
  finalStatus: string;
  budgetExceeded: boolean;
  lastVerifierReceipt?: { exit_code: number } | null | undefined;
  blockedReport?: { reason: string } | null | undefined;
}): TerminalOutcome {
  if (input.budgetExceeded) return 'BUDGET_EXHAUSTED';
  switch (input.finalStatus) {
    case 'completed':
      return (input.lastVerifierReceipt && input.lastVerifierReceipt.exit_code === 0)
        ? 'VERIFIED_COMPLETE'
        : 'UNVERIFIED_PATCH';
    case 'blocked':
      // Distinguish policy blocks (critic, gate, auto-continue, tamper,
      // zero-write) from external blocks (missing dep, permission, etc.).
      if (
        input.blockedReport &&
        /auto.continue|verification|verifier|gate|critic|zero.write|tamper/i.test(
          input.blockedReport.reason,
        )
      ) {
        return 'BLOCKED_POLICY';
      }
      return 'BLOCKED_EXTERNAL';
    case 'cancelled':
      return 'CANCELLED';
    case 'failed':
      return 'AGENT_FAILURE';
  }
  return 'AGENT_FAILURE';
}

// ─── P0-B: Provider conversation population ──────────────────────────────

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
): DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner {
  const isDS = modelName.toLowerCase().includes('deepseek');
  const isOL = modelName.toLowerCase().includes('ollama') || modelName.includes(':');
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
