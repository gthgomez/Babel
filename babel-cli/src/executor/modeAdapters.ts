/**
 * Mode adapters — the renderer-free preparation and mode-capability contract.
 *
 * P02 introduces one place that answers "what does this mode actually do on
 * this surface?" and one shape for describing whether cold resume restored the
 * state a turn needs. It deliberately imports nothing from `interactive/` or
 * the renderer: preparation output must not depend on how it is displayed.
 */

import type { BabelMode, SessionDescriptor } from './contracts.js';

/** Which controller actually owns execution for a mode. */
export type ModeControllerKind = 'chat_engine' | 'v9_pipeline' | 'none';

export interface ModeCapability {
  mode: BabelMode;
  /** Whether this surface can admit new execution for the mode. */
  submission: boolean;
  /** Whether this surface can restore a prior turn for the mode. */
  resume: boolean;
  controller: ModeControllerKind;
  reason?: string;
}

/**
 * Mode capability on the current protocol surface.
 *
 * `chat` and `plan` run through ChatEngine (plan stays a hard-plan lane).
 * `deep` must route through the real V9 pipeline; until that adapter is wired
 * here it is explicitly unsupported rather than silently substituted with a
 * ChatEngine carrying a `deep` execution profile.
 */
export function resolveModeCapability(mode: BabelMode): ModeCapability {
  switch (mode) {
    case 'chat':
      return { mode, submission: true, resume: true, controller: 'chat_engine' };
    case 'plan':
      return { mode, submission: true, resume: true, controller: 'chat_engine' };
    case 'deep':
      return {
        mode,
        submission: false,
        resume: false,
        controller: 'v9_pipeline',
        reason: 'The V9 pipeline controller is not wired to this surface yet',
      };
  }
}

/** Where a cold restore is allowed to read durable state from. */
export type RestoreSource = 'thread_event_log' | 'history_cells' | 'none';

/**
 * Result of inspecting durable state before a resumed turn.
 *
 * `resumable:false` means the surface must refuse to execute rather than run on
 * an empty engine; `missing` names exactly what could not be reconstructed.
 */
export interface RestoreReport {
  threadId: string;
  mode: BabelMode;
  resumable: boolean;
  source: RestoreSource;
  turnCount: number;
  missing: string[];
  reason?: string;
}

/**
 * Renderer-free description of a turn about to be prepared. Superset of the
 * fields each mode's controller needs; contains no UI/renderer state.
 */
export interface PreparedTurn {
  threadId: string;
  mode: BabelMode;
  controller: ModeControllerKind;
  task: string;
  projectRoot: string;
  provider: string;
  model: string;
  policyProfile: string;
}

export function buildPreparedTurn(descriptor: SessionDescriptor): PreparedTurn {
  return {
    threadId: descriptor.threadId,
    mode: descriptor.mode,
    controller: resolveModeCapability(descriptor.mode).controller,
    task: descriptor.task ?? `Session ${descriptor.threadId}`,
    projectRoot: descriptor.projectRoot,
    provider: descriptor.provider,
    model: descriptor.model,
    policyProfile: descriptor.policyProfile,
  };
}
