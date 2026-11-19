// ─── Chat Transcript Hydration ──────────────────────────────────────────────
// Maps persisted ChatEngine transcript.jsonl messages into REPL InteractiveTurn
// records so /chat and /resume show the same history the engine restored.

import { readFileSync } from 'node:fs';

import type { ChatMessage } from '../agent/chatToolDefinitions.js';
import { cellsToChatMessages } from '../services/threadStore/conversationSync.js';
import {
  terminalOutcomeFromLegacyStatus,
  isTerminalOutcome,
} from '../services/durableTerminalTruth.js';
import { userFacingStatusFromOutcome } from '../cli/userFacingStatus.js';
import type { HistoryCellRecord } from '../ui/historyCells/types.js';
import type { ReplContext } from './context.js';
import type { InteractiveTurn } from './types.js';

export interface RecoveredTerminal {
  outcome?: string | null;
  status?: string | null;
}

export interface ChatTranscriptHydrationContext {
  targetRoot?: string | null;
  workspaceRoot?: string | null;
  /** ISO timestamp base for synthetic turn timestamps (e.g. session mtime). */
  baseTimestamp?: string;
  /** Durable terminal record for the recovered session, when available. */
  terminal?: RecoveredTerminal | null | undefined;
}

type RecoveredUserStatus =
  | 'ready'
  | 'complete'
  | 'not_verified'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'budget_exhausted';

/** One recovered status classification derived from durable terminal evidence. */
function recoveredUserStatus(
  terminal: RecoveredTerminal | null | undefined,
  hasAssistant: boolean,
): RecoveredUserStatus {
  if (!terminal) return hasAssistant ? 'complete' : 'ready';
  const outcome = isTerminalOutcome(terminal.outcome)
    ? terminal.outcome
    : terminalOutcomeFromLegacyStatus(terminal.status);
  if (outcome) {
    const userStatus = userFacingStatusFromOutcome(outcome);
    if (userStatus === 'success') return 'complete';
    if (userStatus === 'not_verified' || userStatus === 'partial') return 'not_verified';
    if (userStatus === 'failed') return outcome === 'CANCELLED' ? 'cancelled' : outcome === 'BUDGET_EXHAUSTED' ? 'budget_exhausted' : 'failed';
    return 'blocked';
  }
  const status = (terminal.status ?? '').toLowerCase();
  if (status === 'failed' || status === 'budget_exhausted') return 'failed';
  if (status === 'blocked') return 'blocked';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'completed') return 'not_verified';
  return hasAssistant ? 'complete' : 'ready';
}

function isDisplayAssistantMessage(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.name !== 'tool_calls' &&
    typeof message.content === 'string' &&
    message.content.trim().length > 0
  );
}

/**
 * Convert ChatEngine transcript messages into user/assistant display turns.
 * Skips system/tool rows; uses the last substantive assistant message before
 * each next user message as the answer for that exchange.
 */
export function chatMessagesToInteractiveTurns(
  messages: ChatMessage[],
  context: ChatTranscriptHydrationContext = {},
): InteractiveTurn[] {
  const turns: InteractiveTurn[] = [];
  const baseTs = context.baseTimestamp ?? new Date().toISOString();
  let turnId = 0;

  const pushTurn = (partial: Omit<InteractiveTurn, 'schema_version' | 'turn_id' | 'ts'>): void => {
    turnId += 1;
    turns.push({
      schema_version: 1,
      turn_id: turnId,
      ts: baseTs,
      ...partial,
    });
  };

  let pendingUser: string | null = null;
  let pendingAssistant: string[] | null = null;

  const flushExchange = (): void => {
    if (pendingUser !== null) {
      pushTurn({
        role: 'user',
        input: pendingUser,
        target_root: context.targetRoot ?? null,
        workspace_root: context.workspaceRoot ?? null,
      });
      pendingUser = null;
    }
    if (pendingAssistant !== null) {
      const answer = pendingAssistant.join('\n\n').trim();
      pushTurn({
        role: 'assistant',
        answer,
        summary: answer.slice(0, 200),
        run_dir: null,
        target_root: context.targetRoot ?? null,
        workspace_root: context.workspaceRoot ?? null,
        changed_files: [],
        verification: null,
        next: null,
      });
      pendingAssistant = null;
    }
  };

  for (const message of messages) {
    if (message.role === 'user' && typeof message.content === 'string') {
      flushExchange();
      pendingUser = message.content;
      pendingAssistant = null;
      continue;
    }
    if (isDisplayAssistantMessage(message)) {
      // Keep every retained assistant message in the exchange: a model
      // candidate and a later terminal response are both durable archive
      // facts, and a failed terminal response must not erase the answer
      // (UX-10).
      const content = message.content.trim();
      if (content.length === 0) continue;
      if (pendingAssistant === null) pendingAssistant = [];
      if (pendingAssistant.at(-1) !== content) pendingAssistant.push(content);
    }
  }

  flushExchange();
  return turns;
}

// readFileSync is acceptable here: called once at session start or /resume,
// before any rendering or streaming I/O begins. The transcript files are
// small (JSONL) and blocking is brief.
export function parseChatTranscriptFile(transcriptPath: string): ChatMessage[] {
  const content = readFileSync(transcriptPath, 'utf-8');
  return content
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ChatMessage);
}

/**
 * Populate ctx.turns (and related counters) from a chat session transcript.
 * Returns counts for operator feedback.
 */
export function hydrateReplTurnsFromChatTranscript(
  ctx: ReplContext,
  input: {
    sessionId: string;
    transcriptPath: string;
    targetRoot: string;
    workspaceRoot?: string | null;
    baseTimestamp?: string;
    terminal?: RecoveredTerminal | null | undefined;
  },
): { turnCount: number; exchangeCount: number } {
  const messages = parseChatTranscriptFile(input.transcriptPath);
  const turns = chatMessagesToInteractiveTurns(messages, {
    targetRoot: input.targetRoot,
    workspaceRoot: input.workspaceRoot ?? null,
    ...(input.baseTimestamp !== undefined ? { baseTimestamp: input.baseTimestamp } : {}),
    ...(input.terminal !== undefined ? { terminal: input.terminal } : {}),
  });

  ctx.turns = turns;
  ctx.turnCounter = turns.length > 0 ? turns[turns.length - 1]!.turn_id : 0;

  const lastAssistant = [...turns].reverse().find((turn) => turn.role === 'assistant');
  const status = recoveredUserStatus(input.terminal, lastAssistant !== undefined);
  ctx.lastAssistantAnswer = lastAssistant?.answer ?? null;
  ctx.lastAssistantNext = null;
  ctx.lastAssistantStatus = status;
  ctx.lastResolvedTask = null;
  ctx.lastRunDir = null;
  ctx.state.lastRunUserStatus = status;

  const exchangeCount = turns.filter((turn) => turn.role === 'user').length;
  return { turnCount: turns.length, exchangeCount };
}

/** Populate ctx.turns from committed HistoryCell records (thread-store resume). */
export function hydrateReplTurnsFromCells(
  ctx: ReplContext,
  records: HistoryCellRecord[],
  context: ChatTranscriptHydrationContext = {},
): { turnCount: number; exchangeCount: number } {
  const turns = chatMessagesToInteractiveTurns(cellsToChatMessages(records), context);
  ctx.turns = turns;
  ctx.turnCounter = turns.length > 0 ? turns[turns.length - 1]!.turn_id : 0;

  const lastAssistant = [...turns].reverse().find((turn) => turn.role === 'assistant');
  const status = recoveredUserStatus(context.terminal, lastAssistant !== undefined);
  ctx.lastAssistantAnswer = lastAssistant?.answer ?? null;
  ctx.lastAssistantNext = null;
  ctx.lastAssistantStatus = status;
  ctx.lastResolvedTask = null;
  ctx.lastRunDir = null;
  ctx.state.lastRunUserStatus = status;

  const exchangeCount = turns.filter((turn) => turn.role === 'user').length;
  return { turnCount: turns.length, exchangeCount };
}