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

/** Built-in adapters ship disabled until host installation is verified. */
export const PLANNED_EXTERNAL_ADAPTERS: HarnessAdapterDescriptor[] = [
  {
    id: 'command-code',
    displayName: 'Command Code CLI',
    version: 'unverified',
    capabilities: {
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
    },
    unsupportedReason: 'Live TUI attach is not established; use Babel-managed ACP runtime.',
  },
];
