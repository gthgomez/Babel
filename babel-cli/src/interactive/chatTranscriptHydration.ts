// ─── Chat Transcript Hydration ──────────────────────────────────────────────
// Maps persisted ChatEngine transcript.jsonl messages into REPL InteractiveTurn
// records so /chat and /resume show the same history the engine restored.

import { readFileSync } from 'node:fs';

import type { ChatMessage } from '../agent/chatToolDefinitions.js';
import { cellsToChatMessages } from '../services/threadStore/conversationSync.js';
import type { HistoryCellRecord } from '../ui/historyCells/types.js';
import type { ReplContext } from './context.js';
import type { InteractiveTurn } from './types.js';

export interface ChatTranscriptHydrationContext {
  targetRoot?: string | null;
  workspaceRoot?: string | null;
  /** ISO timestamp base for synthetic turn timestamps (e.g. session mtime). */
  baseTimestamp?: string;
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
  let pendingAssistant: string | null = null;

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
      pushTurn({
        role: 'assistant',
        answer: pendingAssistant,
        summary: pendingAssistant.slice(0, 200),
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
      pendingAssistant = message.content;
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
  },
): { turnCount: number; exchangeCount: number } {
  const messages = parseChatTranscriptFile(input.transcriptPath);
  const turns = chatMessagesToInteractiveTurns(messages, {
    targetRoot: input.targetRoot,
    workspaceRoot: input.workspaceRoot ?? null,
    ...(input.baseTimestamp !== undefined ? { baseTimestamp: input.baseTimestamp } : {}),
  });

  ctx.turns = turns;
  ctx.turnCounter = turns.length > 0 ? turns[turns.length - 1]!.turn_id : 0;

  const lastAssistant = [...turns].reverse().find((turn) => turn.role === 'assistant');
  ctx.lastAssistantAnswer = lastAssistant?.answer ?? null;
  ctx.lastAssistantNext = null;
  ctx.lastAssistantStatus = null;
  ctx.lastResolvedTask = null;
  ctx.lastRunDir = null;
  ctx.state.lastRunUserStatus = lastAssistant ? 'complete' : 'ready';

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
  ctx.lastAssistantAnswer = lastAssistant?.answer ?? null;
  ctx.lastAssistantNext = null;
  ctx.lastAssistantStatus = null;
  ctx.lastResolvedTask = null;
  ctx.lastRunDir = null;
  ctx.state.lastRunUserStatus = lastAssistant ? 'complete' : 'ready';

  const exchangeCount = turns.filter((turn) => turn.role === 'user').length;
  return { turnCount: turns.length, exchangeCount };
}