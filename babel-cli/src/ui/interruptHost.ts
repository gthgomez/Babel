/**
 * Interrupt host — single owner for Ctrl+C / SIGINT in interactive chat.
 *
 * The input arbiter decides the effect. This host applies it: cancel the
 * running turn, clear the composer, hint "press again to exit", decline an
 * overlay, or actually exit. Tests drive handleInteractiveInterrupt from a
 * real start state (prompt, running, paste, overlay).
 */

import {
  dispatchInputArbiter,
  consumeInputArbiterEffects,
  getInputArbiterState,
  resetInputArbiterForTests,
  setProcessSigintHook,
  isDuplicateCtrlC,
  markCtrlCHandled,
  type InputArbiterState,
} from './inputCoordinator.js';

export const EXIT_HINT = 'Press Ctrl+C again to exit.';

export interface InterruptContext {
  composerEmpty: boolean;
  inPaste: boolean;
  overlayActive: boolean;
}

export interface InterruptActions {
  cancelTurn: () => void;
  clearComposer: () => void;
  cancelPaste: () => void;
  declineOverlay: () => void;
  restorePrompt: () => void;
  hintExit: (message: string) => void;
  requestExit: () => void;
}

export interface InterruptResult {
  cancelled: boolean;
  exited: boolean;
  clearedComposer: boolean;
  hintedExit: boolean;
  cancelledPaste: boolean;
  declinedOverlay: boolean;
  processStayedAlive: boolean;
  arbiter: InputArbiterState;
}

const DEFAULT_CONTEXT: InterruptContext = {
  composerEmpty: true,
  inPaste: false,
  overlayActive: false,
};

let registeredActions: InterruptActions | null = null;
let registeredContext: () => InterruptContext = () => DEFAULT_CONTEXT;
let exitRequested = false;
let nextSubmitAllowed = true;

/** Snapshot of composer text saved before an overlay steals the TTY. */
let overlayDraft: string | null = null;
/** Keys typed while a renderer owns raw stdin (type-during-stream). */
let streamingDraft = '';

export function registerInterruptHost(
  actions: InterruptActions,
  context?: () => InterruptContext,
): void {
  registeredActions = actions;
  registeredContext = context ?? (() => DEFAULT_CONTEXT);
  exitRequested = false;
  nextSubmitAllowed = true;
  setProcessSigintHook(handleProcessSigint);
}

export function unregisterInterruptHost(): void {
  registeredActions = null;
  registeredContext = () => DEFAULT_CONTEXT;
  exitRequested = false;
  overlayDraft = null;
  streamingDraft = '';
  setProcessSigintHook(null);
}

export function resetInterruptHostForTests(): void {
  unregisterInterruptHost();
  resetInputArbiterForTests();
}

export function wasExitRequested(): boolean {
  return exitRequested;
}

export function canSubmitNextTask(): boolean {
  return nextSubmitAllowed && !exitRequested;
}

export function snapshotComposerDraft(text: string): void {
  overlayDraft = text;
}

export function takeComposerDraft(): string | null {
  const draft = overlayDraft;
  overlayDraft = null;
  return draft;
}

export function peekComposerDraft(): string | null {
  return overlayDraft;
}

export function appendStreamingDraft(chunk: string): void {
  if (!chunk || chunk === '\u0003') return;
  streamingDraft += chunk;
}

export function takeStreamingDraft(): string {
  const text = streamingDraft;
  streamingDraft = '';
  return text;
}

export function peekStreamingDraft(): string {
  return streamingDraft;
}

export function preserveComposerAcrossResize(getDraft: () => string, setDraft: (t: string) => void): void {
  const draft = getDraft();
  setDraft(draft);
}

/**
 * Apply one Ctrl+C / SIGINT against the live arbiter.
 * When `actions` is omitted, uses the registered host (REPL / renderer).
 */
export function handleInteractiveInterrupt(
  context: Partial<InterruptContext> = {},
  actions?: InterruptActions,
): InterruptResult {
  const ctx: InterruptContext = {
    ...registeredContext(),
    ...context,
  };
  const act = actions ?? registeredActions;
  if (!act) {
    return {
      cancelled: false,
      exited: false,
      clearedComposer: false,
      hintedExit: false,
      cancelledPaste: false,
      declinedOverlay: false,
      processStayedAlive: true,
      arbiter: getInputArbiterState(),
    };
  }

  if (ctx.overlayActive && getInputArbiterState().mode === 'prompt') {
    dispatchInputArbiter({ type: 'dialog_open' });
  }

  markCtrlCHandled();
  const { effects } = dispatchInputArbiter({
    type: 'ctrl_c',
    composerEmpty: ctx.composerEmpty,
    inPaste: ctx.inPaste,
  });
  const flags = consumeInputArbiterEffects(effects);

  if (flags.shouldCancelTurn) {
    act.cancelTurn();
    nextSubmitAllowed = true;
    act.restorePrompt();
  }
  if (flags.shouldClearComposer) {
    act.clearComposer();
    act.restorePrompt();
  }
  if (flags.shouldHintExit) {
    act.hintExit(EXIT_HINT);
    act.restorePrompt();
  }
  if (flags.shouldCancelPaste) {
    act.cancelPaste();
    act.restorePrompt();
  }
  if (flags.shouldDeclineOverlay) {
    act.declineOverlay();
    act.restorePrompt();
  }
  if (flags.shouldExitProcess) {
    exitRequested = true;
    nextSubmitAllowed = false;
    act.requestExit();
  }

  return {
    cancelled: flags.shouldCancelTurn,
    exited: flags.shouldExitProcess,
    clearedComposer: flags.shouldClearComposer,
    hintedExit: flags.shouldHintExit,
    cancelledPaste: flags.shouldCancelPaste,
    declinedOverlay: flags.shouldDeclineOverlay,
    processStayedAlive: !flags.shouldExitProcess,
    arbiter: getInputArbiterState(),
  };
}

/**
 * Process-level SIGINT. Returns true when the host consumed the signal
 * (Babel stays alive). Returns false when the caller should exit.
 */
export function handleProcessSigint(): boolean {
  if (isDuplicateCtrlC()) return true;
  if (!registeredActions) return false;
  const result = handleInteractiveInterrupt();
  return result.processStayedAlive;
}

/** Mark a mutating/chat turn as started so the next Ctrl+C cancels it. */
export function notifyRunStarted(): void {
  dispatchInputArbiter({ type: 'run_started' });
  nextSubmitAllowed = true;
}

/** Return exclusive ownership to the composer after any terminal state. */
export function notifyRunEnded(): void {
  dispatchInputArbiter({ type: 'run_ended' });
  nextSubmitAllowed = true;
}

export function notifyOverlayOpened(draft?: string): void {
  if (draft !== undefined) snapshotComposerDraft(draft);
  dispatchInputArbiter({ type: 'dialog_open' });
}

export function notifyOverlayClosed(): string | null {
  dispatchInputArbiter({ type: 'dialog_close' });
  nextSubmitAllowed = true;
  return takeComposerDraft();
}
