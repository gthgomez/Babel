/**
 * Host-side harness adapter capability contract (remote integrations).
 * Declarations are authoritative for UI gating; they do not sandbox adapter code.
 */

export type HarnessAdapterId =
  | 'babel-native'
  | 'command-code'
  | 'opencode'
  | 'antigravity'
  | 'claude-code'
  | 'codex';

export interface HarnessCapabilityFlags {
  catalog: boolean;
  start: boolean;
  readHistory: boolean;
  resumeStopped: boolean;
  attachLive: boolean;
  stream: boolean;
  steer: boolean;
  cancel: boolean;
  approve: boolean;
  files: boolean;
  diff: boolean;
  usage: boolean;
  exclusiveControl: boolean;
}

export interface HarnessAdapterDescriptor {
  id: HarnessAdapterId;
  displayName: string;
  version: string;
  capabilities: HarnessCapabilityFlags;
  unsupportedReason?: string;
}

export const COMMAND_CODE_ATTACH_LIVE_UNSUPPORTED_REASON =
  'Unmanaged live TUI attach is unsupported; use Babel-managed own-CLI runtime (attachLive=false).';

export const OPENCODE_ATTACH_LIVE_UNSUPPORTED_REASON =
  'Unmanaged live TUI attach is unsupported; use Babel-managed opencode acp runtime (attachLive=false).';

export const OPENCODE_BASE_CAPABILITIES: HarnessCapabilityFlags = {
  catalog: true,
  start: true,
  readHistory: true,
  resumeStopped: true,
  attachLive: false,
  stream: true,
  steer: true,
  cancel: true,
  approve: true,
  files: false,
  diff: false,
  usage: true,
  exclusiveControl: false,
};

export const COMMAND_CODE_BASE_CAPABILITIES: HarnessCapabilityFlags = {
  catalog: true,
  start: true,
  readHistory: true,
  resumeStopped: true,
  attachLive: false,
  stream: true,
  steer: true,
  cancel: true,
  approve: true,
  files: false,
  diff: false,
  usage: true,
  exclusiveControl: false,
};

export const BABEL_NATIVE_ADAPTER: HarnessAdapterDescriptor = {
  id: 'babel-native',
  displayName: 'Babel native',
  version: '1',
  capabilities: {
    catalog: true,
    start: true,
    readHistory: true,
    resumeStopped: true,
    attachLive: true,
    stream: true,
    steer: true,
    cancel: true,
    approve: true,
    files: true,
    diff: true,
    usage: true,
    exclusiveControl: true,
  },
};

/** Campaign order for external own-CLI adapters (not all implemented). */
export const EXTERNAL_ADAPTER_CAMPAIGN_ORDER: HarnessAdapterId[] = [
  'command-code',
  'opencode',
  'antigravity',
  'claude-code',
  'codex',
];

/** Reserved profile ids for future slices (fixtures only; no live qualification). */
export const EXTERNAL_ADAPTER_PROFILE_IDS = Object.freeze({
  commandCodeGoat: 'command-code-goat',
  openCodeGo: 'opencode-go',
});

/** Legacy static placeholder; prefer `buildHarnessAdapterCatalog()`. */
export const PLANNED_EXTERNAL_ADAPTERS: HarnessAdapterDescriptor[] = [];
