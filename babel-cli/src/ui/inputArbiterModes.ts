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
  | { type: 'ctrl_c' }
  | { type: 'force_exit' };

export type InputArbiterEffect =
  | { type: 'cancel_turn' }
  | { type: 'exit_process' }
  | { type: 'ignore' }
  | { type: 'buffer_key' };

export interface InputArbiterState {
  mode: InputArbiterMode;
  /** True after first Ctrl+C during running (cancel issued). */
  cancelArmed: boolean;
  /** Owner label for the exclusive stdin listener in this mode. */
  stdinOwner: string | null;
}

export function initialInputArbiterState(): InputArbiterState {
  return { mode: 'prompt', cancelArmed: false, stdinOwner: 'prompt' };
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
          stdinOwner: STDIN_OWNER.running,
        },
        effects: [],
      };
    case 'run_ended':
      return {
        state: {
          mode: 'prompt',
          cancelArmed: false,
          stdinOwner: STDIN_OWNER.prompt,
        },
        effects: [],
      };
    case 'approval_open':
      return {
        state: {
          mode: 'approval',
          cancelArmed: false,
          stdinOwner: STDIN_OWNER.approval,
        },
        effects: [],
      };
    case 'approval_close':
      return {
        state: {
          mode: state.mode === 'approval' ? 'running' : state.mode,
          cancelArmed: false,
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
          stdinOwner: STDIN_OWNER.dialog,
        },
        effects: [],
      };
    case 'dialog_close':
      return {
        state: {
          mode: 'prompt',
          cancelArmed: false,
          stdinOwner: STDIN_OWNER.prompt,
        },
        effects: [],
      };
    case 'scrollback_enter':
      return {
        state: {
          mode: 'scrollback',
          cancelArmed: false,
          stdinOwner: STDIN_OWNER.scrollback,
        },
        effects: [],
      };
    case 'scrollback_exit':
      return {
        state: {
          mode: 'prompt',
          cancelArmed: false,
          stdinOwner: STDIN_OWNER.prompt,
        },
        effects: [],
      };
    case 'ctrl_c': {
      if (state.mode === 'running') {
        if (!state.cancelArmed) {
          return {
            state: { ...state, cancelArmed: true },
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
        return { state, effects: [{ type: 'exit_process' }] };
      }
      // approval/dialog/scrollback: first Ctrl+C closes overlay (mode-specific)
      if (state.mode === 'approval') {
        return {
          state: {
            mode: 'running',
            cancelArmed: false,
            stdinOwner: STDIN_OWNER.running,
          },
          effects: [{ type: 'ignore' }],
        };
      }
      return {
        state: {
          mode: 'prompt',
          cancelArmed: false,
          stdinOwner: STDIN_OWNER.prompt,
        },
        effects: [{ type: 'ignore' }],
      };
    }
    case 'force_exit':
      return { state, effects: [{ type: 'exit_process' }] };
    case 'submit':
      return { state, effects: [] };
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
} {
  let shouldCancelTurn = false;
  let shouldExitProcess = false;
  for (const e of effects) {
    if (e.type === 'cancel_turn') shouldCancelTurn = true;
    if (e.type === 'exit_process') shouldExitProcess = true;
  }
  return { shouldCancelTurn, shouldExitProcess };
}
