// ─── Barrel re-export ──────────────────────────────────────────────────────
// interactive.ts is now a thin barrel. BabelRepl lives in interactive/BabelRepl.ts
// and all command/execution logic is in the interactive/ subdirectory.

export { BabelRepl, startInteractiveSession } from './interactive/BabelRepl.js';
export {
  APPROVAL_READY_STATUSES,
  INTERACTIVE_COMMAND_GROUPS,
  type SessionState,
  type InteractiveTurn,
  type InteractiveTaskIntentOptions,
  type InteractiveDailyCommand,
} from './interactive/types.js';
export {
  parseInteractiveDailyCommand,
  classifyInteractiveTaskIntent,
} from './interactive/parsers.js';
