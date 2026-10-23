import type { HarnessAdapterDescriptor } from './harnessAdapterContract.js';
import {
  COMMAND_CODE_ATTACH_LIVE_UNSUPPORTED_REASON,
  type HarnessCapabilityFlags,
} from './harnessAdapterContract.js';
import type { ClaudeSdkIntegrityProbe } from './claudeCodeIntegrity.js';
import { probeClaudeSdkIntegrity } from './claudeCodeIntegrity.js';
import { CLAUDE_HOST_BROKERED_TOOLS } from './claudeCodePermissionBridge.js';

export const CLAUDE_CODE_ATTACH_LIVE_UNSUPPORTED_REASON = COMMAND_CODE_ATTACH_LIVE_UNSUPPORTED_REASON;

export const CLAUDE_CODE_BASE_CAPABILITIES: HarnessCapabilityFlags = {
  catalog: true,
  start: true,
  readHistory: false,
  resumeStopped: true,
  attachLive: false,
  stream: true,
  steer: false,
  cancel: true,
  approve: true,
  files: false,
  diff: false,
  usage: true,
  exclusiveControl: false,
};

export async function probeClaudeCodeInstallation(options?: {
  integrityProbe?: () => Promise<ClaudeSdkIntegrityProbe>;
}): Promise<ClaudeSdkIntegrityProbe> {
  return options?.integrityProbe?.() ?? probeClaudeSdkIntegrity();
}

export function buildClaudeCodeAdapterDescriptor(probe: ClaudeSdkIntegrityProbe): HarnessAdapterDescriptor {
  const version =
    probe.state === 'verified'
      ? probe.cliVersion ?? 'verified'
      : probe.state === 'missing'
        ? 'not-installed'
        : 'unverified';

  const enabled = probe.state === 'verified';
  return {
    id: 'claude-code',
    displayName: 'Claude Code CLI (Agent SDK)',
    version,
    capabilities: {
      ...CLAUDE_CODE_BASE_CAPABILITIES,
      catalog: enabled,
      start: enabled,
      resumeStopped: enabled,
      stream: enabled,
      cancel: enabled,
      approve: enabled,
      usage: enabled,
    },
    unsupportedReason: enabled
      ? `${CLAUDE_CODE_ATTACH_LIVE_UNSUPPORTED_REASON} Host brokers ${CLAUDE_HOST_BROKERED_TOOLS.join(', ')} at canUseTool; unmapped tool names are denied by the bridge.`
      : probe.state === 'missing'
        ? 'Claude Agent SDK pin is not installed on this host.'
        : probe.detail ?? 'Claude Agent SDK installation could not be verified locally.',
  };
}
