import type { HarnessAdapterDescriptor, HarnessCapabilityFlags } from './harnessAdapterContract.js';
import {
  ANTIGRAVITY_ATTACH_LIVE_UNSUPPORTED_REASON,
  ANTIGRAVITY_OFFLINE_FOUNDATION_REASON,
} from './harnessAdapterContract.js';

export const ANTIGRAVITY_DISABLED_CAPABILITIES: HarnessCapabilityFlags = {
  catalog: false,
  start: false,
  readHistory: false,
  resumeStopped: false,
  attachLive: false,
  stream: false,
  steer: false,
  cancel: false,
  approve: false,
  files: false,
  diff: false,
  usage: false,
  exclusiveControl: false,
};

export const ANTIGRAVITY_UNSUPPORTED_REASON =
  `${ANTIGRAVITY_OFFLINE_FOUNDATION_REASON} ${ANTIGRAVITY_ATTACH_LIVE_UNSUPPORTED_REASON}`;

export function buildAntigravityAdapterDescriptor(): HarnessAdapterDescriptor {
  return {
    id: 'antigravity',
    displayName: 'Antigravity CLI (AGY)',
    version: 'offline-foundation',
    capabilities: { ...ANTIGRAVITY_DISABLED_CAPABILITIES },
    unsupportedReason: ANTIGRAVITY_UNSUPPORTED_REASON,
  };
}
