// ─── ReplContext Interface ────────────────────────────────────────────────────
// Shared state contract between BabelRepl and extracted modules.
//
// BabelRepl implements this interface by making its private fields public.
// Extracted command handlers, execution engines, and utility functions receive
// a ReplContext as their first parameter instead of accessing `this`.
//
// Tests continue working because `Object.create(BabelRepl.prototype)` produces
// an object whose shape satisfies this interface (fields are set directly).

import type * as readline from 'node:readline/promises';
import type { ScreenManager } from '../ui/screenManager.js';
import type { AgentTargetContext } from '../services/targetResolver.js';
import type { InteractiveTurn, SessionState } from './types.js';
import type { ChatEngine } from '../agent/chatEngine.js';

export interface ReplContext {
  // ── I/O ──────────────────────────────────────────────────────────────────
  rl: readline.Interface;

  // ── Session state ────────────────────────────────────────────────────────
  state: SessionState;
  isRunning: boolean;
  verboseMode: boolean;
  projectSettingsApplied: boolean;

  // ── Run tracking ─────────────────────────────────────────────────────────
  lastRunDir: string | null;
  lastRunTranscript: string | null;
  currentStageIdx: number;

  // ── Session identity ─────────────────────────────────────────────────────
  interactiveSessionId: string;
  interactiveSessionDir: string;
  interactiveTranscriptPath: string;

  // ── Turn tracking ────────────────────────────────────────────────────────
  turnCounter: number;
  turns: InteractiveTurn[];
  lastAssistantAnswer: string | null;
  lastAssistantNext: string | null;
  lastAssistantStatus: string | null;
  lastResolvedTask: string | null;
  lastSessionRunDir: string | null;

  // ── Target resolution ────────────────────────────────────────────────────
  lastTargetRoot: string | null;
  lastWorkspaceRoot: string | null;
  targetOverrideRoot: string | null;

  // ── Caching ──────────────────────────────────────────────────────────────
  warmedIndexRoots: Set<string>;
  sessionIdentity: string | null;
  sessionIdentityRoot: string | null;

  // ── Log buffer ───────────────────────────────────────────────────────────
  logBuffer: string[];

  // ── Paste mode ───────────────────────────────────────────────────────────
  pasteBuffer: string[];
  inPaste: boolean;

  // ── ScreenManager ────────────────────────────────────────────────────────
  screenManager: ScreenManager | undefined;

  // ── Session resume ───────────────────────────────────────────────────────
  /** Persisted ChatEngine restored via /resume. When set, executeChatTask
   *  reuses this engine instead of creating a new one, continuing the prior
   *  conversation. Cleared on /clear or when a new engine is created. */
  chatEngine: ChatEngine | undefined;

  /** Last routing-status label for the status bar (e.g. "Flash·mutate").
   *  Set after each chat run from the last TurnRoutingReceipt. */
  lastRoutingLabel: string | null;

  // ── Callbacks (methods on BabelRepl that extracted modules call back) ────
  printIdleHeader(): void;
  renderTurnStatusBar(): void;
  saveSessionState(): void;
  resolveSessionModel(): void;
  appendTurn(turn: Omit<InteractiveTurn, 'schema_version' | 'turn_id' | 'ts'>): InteractiveTurn;
  resolveCurrentTarget(): AgentTargetContext;
  scheduleIndexWarmup(projectRoot: string): void;
  exit(): void;
}
