/**
 * P2-B — Single input arbiter with explicit modes.
 *
 * Modes: prompt | running | approval | dialog | scrollback
 * First Ctrl+C cancels the active turn; a second explicit action exits.
 */

export type InputArbiterMode =
  | 'prompt'
  | 'running'
  | 'approval'
  | 'dialog'
  | 'scrollback';

export type InputArbiterEvent =
  | { type: 'submit' }
  | { type: 'run_started' }
  | { type: 'run_ended' }
  | { type: 'approval_open' }
  | { type: 'approval_close' }
  | { type: 'dialog_open' }
  | { type: 'dialog_close' }
  | { type: 'scrollback_enter' }
  | { type: 'scrollback_exit' }
  | {
      type: 'ctrl_c';
      /** Idle composer has no text. Ignored while a run owns input. */
      composerEmpty?: boolean;
      /** Multiline / ``` paste mode is active. */
      inPaste?: boolean;
    }
  | { type: 'force_exit' };

export type InputArbiterEffect =
  | { type: 'cancel_turn' }
  | { type: 'exit_process' }
  | { type: 'clear_composer' }
  | { type: 'hint_exit' }
  | { type: 'cancel_paste' }
  | { type: 'decline_overlay' }
  | { type: 'ignore' }
  | { type: 'buffer_key' };

export interface InputArbiterState {
  mode: InputArbiterMode;
  /** True after first Ctrl+C during running (cancel issued). */
  cancelArmed: boolean;
  /** True after first Ctrl+C on an empty idle composer (exit affordance). */
  exitArmed: boolean;
  /** Owner label for the exclusive stdin listener in this mode. */
  stdinOwner: string | null;
}

export function initialInputArbiterState(): InputArbiterState {
  return { mode: 'prompt', cancelArmed: false, exitArmed: false, stdinOwner: 'prompt' };
}

const STDIN_OWNER: Record<InputArbiterMode, string> = {
  prompt: 'prompt',
  running: 'running',
  approval: 'approval',
  dialog: 'dialog',
  scrollback: 'scrollback',
};

/**
 * Pure transition: exactly one stdin owner per mode.
 */
export function reduceInputArbiter(
  state: InputArbiterState,
  event: InputArbiterEvent,
): { state: InputArbiterState; effects: InputArbiterEffect[] } {
  switch (event.type) {
    case 'run_started':
      return {
        state: {
          mode: 'running',
          cancelArmed: false,
          exitArmed: false,
          stdinOwner: STDIN_OWNER.running,
        },
        effects: [],
      };
    case 'run_ended':
      return {
        state: {
          mode: 'prompt',
          cancelArmed: false,
          exitArmed: false,
          stdinOwner: STDIN_OWNER.prompt,
        },
        effects: [],
      };
    case 'approval_open':
      return {
        state: {
          mode: 'approval',
          cancelArmed: false,
          exitArmed: false,
          stdinOwner: STDIN_OWNER.approval,
        },
        effects: [],
      };
    case 'approval_close':
      return {
        state: {
          mode: state.mode === 'approval' ? 'running' : state.mode,
          cancelArmed: false,
          exitArmed: false,
          stdinOwner:
            state.mode === 'approval'
              ? STDIN_OWNER.running
              : state.stdinOwner,
        },
        effects: [],
      };
    case 'dialog_open':
      return {
        state: {
          mode: 'dialog',
          cancelArmed: false,
          exitArmed: false,
          stdinOwner: STDIN_OWNER.dialog,
        },
        effects: [],
      };
    case 'dialog_close':
      return {
        state: {
          mode: 'prompt',
          cancelArmed: false,
          exitArmed: false,
          stdinOwner: STDIN_OWNER.prompt,
        },
        effects: [],
      };
    case 'scrollback_enter':
      return {
        state: {
          mode: 'scrollback',
          cancelArmed: false,
          exitArmed: false,
          stdinOwner: STDIN_OWNER.scrollback,
        },
        effects: [],
      };
    case 'scrollback_exit':
      return {
        state: {
          mode: 'prompt',
          cancelArmed: false,
          exitArmed: false,
          stdinOwner: STDIN_OWNER.prompt,
        },
        effects: [],
      };
    case 'ctrl_c': {
      if (state.mode === 'running') {
        if (!state.cancelArmed) {
          return {
            state: { ...state, cancelArmed: true, exitArmed: false },
            effects: [{ type: 'cancel_turn' }],
          };
        }
        // Second Ctrl+C while still running after cancel: exit.
        return {
          state: { ...state },
          effects: [{ type: 'exit_process' }],
        };
      }
      if (state.mode === 'prompt') {
        if (event.inPaste) {
          return {
            state: { ...state, exitArmed: false },
            effects: [{ type: 'cancel_paste' }],
          };
        }
        if (event.composerEmpty === false) {
          return {
            state: { ...state, exitArmed: false },
            effects: [{ type: 'clear_composer' }],
          };
        }
        if (!state.exitArmed) {
          return {
            state: { ...state, exitArmed: true },
            effects: [{ type: 'hint_exit' }],
          };
        }
        return { state, effects: [{ type: 'exit_process' }] };
      }
      // approval/dialog/scrollback: first Ctrl+C declines overlay
      if (state.mode === 'approval') {
        return {
          state: {
            mode: 'running',
            cancelArmed: false,
            exitArmed: false,
            stdinOwner: STDIN_OWNER.running,
          },
          effects: [{ type: 'decline_overlay' }],
        };
      }
      return {
        state: {
          mode: 'prompt',
          cancelArmed: false,
          exitArmed: false,
          stdinOwner: STDIN_OWNER.prompt,
        },
        effects: [{ type: 'decline_overlay' }],
      };
    }
    case 'force_exit':
      return { state, effects: [{ type: 'exit_process' }] };
    case 'submit':
      return { state: { ...state, exitArmed: false }, effects: [] };
    default: {
      const _e: never = event;
      void _e;
      return { state, effects: [] };
    }
  }
}

/**
 * Structural honesty: list of modes that may own raw stdin.
 * Tests assert only one owner is active at a time.
 */
export function activeStdinOwners(state: InputArbiterState): string[] {
  return state.stdinOwner ? [state.stdinOwner] : [];
}

/** Advertised footer shortcuts that must be wired or removed (P2-B). */
export const ADVERTISED_FOOTER_SHORTCUTS = [
  /** First Ctrl+C → cancel_turn (engine); second → exit_process (host must consume). */
  { key: 'Ctrl+C', action: 'cancel_or_exit', wired: true },
  /** Escape cancel is host/REPL-owned; not auto-wired in engine. */
  { key: 'Escape', action: 'cancel_turn', wired: false },
  { key: 'Ctrl+D', action: 'exit_process', wired: true },
] as const;

export function wiredFooterShortcuts(): Array<{ key: string; action: string }> {
  return ADVERTISED_FOOTER_SHORTCUTS.filter((s) => s.wired).map((s) => ({
    key: s.key,
    action: s.action,
  }));
}

/** Host/REPL helper: interpret arbiter effects after dispatchInputArbiter. */
export function consumeInputArbiterEffects(effects: InputArbiterEffect[]): {
  shouldCancelTurn: boolean;
  shouldExitProcess: boolean;
  shouldClearComposer: boolean;
  shouldHintExit: boolean;
  shouldCancelPaste: boolean;
  shouldDeclineOverlay: boolean;
} {
  let shouldCancelTurn = false;
  let shouldExitProcess = false;
  let shouldClearComposer = false;
  let shouldHintExit = false;
  let shouldCancelPaste = false;
  let shouldDeclineOverlay = false;
  for (const e of effects) {
    if (e.type === 'cancel_turn') shouldCancelTurn = true;
    if (e.type === 'exit_process') shouldExitProcess = true;
    if (e.type === 'clear_composer') shouldClearComposer = true;
    if (e.type === 'hint_exit') shouldHintExit = true;
    if (e.type === 'cancel_paste') shouldCancelPaste = true;
    if (e.type === 'decline_overlay') shouldDeclineOverlay = true;
  }
  return {
    shouldCancelTurn,
    shouldExitProcess,
    shouldClearComposer,
    shouldHintExit,
    shouldCancelPaste,
    shouldDeclineOverlay,
  };
}
