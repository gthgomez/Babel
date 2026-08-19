/**
 * Chat session transport — direct ChatEngine vs protocol client (D2).
 */

import type { ChatEngine, ChatEngineOptions, ChatEvent } from '../../agent/chatEngine.js';
import {
  allocateThreadViaProtocol,
  getProtocolClient,
  isProtocolClientEnabled,
  registerEngineWithProtocolHost,
} from '../../protocol/client/index.js';
import { mapChatEventToTurnStreamEvent } from '../../protocol/mapChatEvent.js';
import type {
  CellCommittedParams,
  TurnEventParams,
} from '../../protocol/types.js';
import { ensureThread, loadThreadCells, resolveNextTurnId } from '../../services/threadStore/index.js';
import type { HistoryCellRecord } from '../../ui/historyCells/types.js';
import type { ConversationalRenderer } from '../../ui/waterfall.js';
import { TurnPersistence } from './turnPersistence.js';

export { mapChatEventToTurnStreamEvent };

export type ProtocolNotification =
  | { method: 'turn.event'; params: TurnEventParams }
  | { method: 'cell.committed'; params: CellCommittedParams };

let protocolNotificationSink: ((notification: ProtocolNotification) => void) | null = null;

/** Test hook — collect protocol notifications without stdio transport. */
export function setProtocolNotificationSink(
  sink: ((notification: ProtocolNotification) => void) | null,
): void {
  protocolNotificationSink = sink;
}

function dispatchProtocolNotification(notification: ProtocolNotification): void {
  protocolNotificationSink?.(notification);
}

/** Narrow engine surface required for protocol + thread-store orchestration. */
export function getEngineThreadId(engine: ChatEngine): string | null {
  if (typeof engine.getEngineRunId !== 'function') return null;
  return engine.getEngineRunId() ?? null;
}

export class ProtocolTurnSession {
  readonly threadId: string;
  readonly turnId: number;
  private seq = 0;

  constructor(threadId: string, turnId: number) {
    this.threadId = threadId;
    this.turnId = turnId;
  }

  emitChatEvent(event: ChatEvent): void {
    if (!isProtocolClientEnabled()) return;
    const mapped = mapChatEventToTurnStreamEvent(event);
    if (!mapped) return;
    const params: TurnEventParams = {
      thread_id: this.threadId,
      turn_id: this.turnId,
      seq: this.seq++,
      event: mapped,
    };
    dispatchProtocolNotification({ method: 'turn.event', params });
  }

  emitCellCommitted(cells: HistoryCellRecord[]): void {
    if (!isProtocolClientEnabled() || cells.length === 0) return;
    const params: CellCommittedParams = {
      thread_id: this.threadId,
      turn_id: this.turnId,
      cells,
    };
    dispatchProtocolNotification({ method: 'cell.committed', params });
  }
}

export async function beginProtocolTurn(
  engine: ChatEngine,
  message: string,
): Promise<ProtocolTurnSession | null> {
  if (!isProtocolClientEnabled()) return null;
  const threadId = getEngineThreadId(engine);
  if (!threadId) return null;
  ensureThread(threadId);
  registerEngineWithProtocolHost(threadId, engine);
  const submitted = await getProtocolClient().turnSubmit({
    thread_id: threadId,
    message,
  });
  return new ProtocolTurnSession(threadId, submitted.turn_id);
}

export function loadCommittedTurnCells(threadId: string, turnId: number): HistoryCellRecord[] {
  return loadThreadCells(threadId).filter((cell) => cell.turn_id === turnId);
}

export function finalizeProtocolTurn(session: ProtocolTurnSession | null): void {
  if (!session) return;
  session.emitCellCommitted(loadCommittedTurnCells(session.threadId, session.turnId));
}

export async function createChatEngineForSession(
  options: ChatEngineOptions,
  engineFactory: (opts: ChatEngineOptions) => ChatEngine,
): Promise<ChatEngine> {
  const engine = engineFactory(options);
  const protocolThreadId = await allocateThreadViaProtocol(options);
  if (protocolThreadId) {
    engine.assignRunId(protocolThreadId);
    registerEngineWithProtocolHost(protocolThreadId, engine);
  }
  return engine;
}

export interface RendererTurnContext {
  protocolSession: ProtocolTurnSession | null;
  turnPersistence: TurnPersistence | null;
}

export async function prepareRendererTurn(
  convRenderer: ConversationalRenderer,
  engine: ChatEngine,
  task: string,
  protocolSession?: ProtocolTurnSession | null,
): Promise<RendererTurnContext> {
  const threadId = getEngineThreadId(engine);
  const session = protocolSession ?? (threadId ? await beginProtocolTurn(engine, task) : null);
  const turnId =
    session?.turnId ?? (threadId ? resolveNextTurnId(threadId) : 0);
  const turnPersistence =
    threadId && turnId > 0 ? new TurnPersistence(threadId, turnId) : null;

  convRenderer.setTaskLabel(task);
  convRenderer.start();
  turnPersistence?.persistUserMessage(task);

  return { protocolSession: session, turnPersistence };
}

export async function prepareHeadlessTurn(
  engine: ChatEngine,
  task: string,
): Promise<RendererTurnContext> {
  const threadId = getEngineThreadId(engine);
  const session = threadId ? await beginProtocolTurn(engine, task) : null;
  const turnId =
    session?.turnId ?? (threadId ? resolveNextTurnId(threadId) : 0);
  const turnPersistence =
    threadId && turnId > 0 ? new TurnPersistence(threadId, turnId) : null;
  turnPersistence?.persistUserMessage(task);
  return { protocolSession: session, turnPersistence };
}

export function isChatProtocolMode(): boolean {
  return isProtocolClientEnabled();
}

/** @deprecated Use prepareRendererTurn */
export async function wireRendererThreadContext(
  convRenderer: ConversationalRenderer,
  engine: ChatEngine,
  task: string,
  protocolSession?: ProtocolTurnSession | null,
): Promise<ProtocolTurnSession | null> {
  const ctx = await prepareRendererTurn(convRenderer, engine, task, protocolSession);
  return ctx.protocolSession;
}
