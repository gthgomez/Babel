import {
  BABEL_NATIVE_ADAPTER,
  EXTERNAL_ADAPTER_CAMPAIGN_ORDER,
  EXTERNAL_ADAPTER_PROFILE_IDS,
  type HarnessAdapterDescriptor,
  type HarnessAdapterId,
  type HarnessCapabilityFlags,
} from './harnessAdapterContract.js';
import { probeCommandCodeInstallation, type CommandCodeInstallProbe } from './commandCodeCliDiscovery.js';
import { probeOpenCodeInstallation, type OpenCodeInstallProbe } from './openCodeCliDiscovery.js';
import { buildAntigravityAdapterDescriptor } from './antigravityOwnCliAdapter.js';
import { buildCommandCodeAdapterDescriptor } from './commandCodeOwnCliAdapter.js';
import { buildOpenCodeAdapterDescriptor } from './openCodeOwnCliAdapter.js';

export type HarnessAdapterInstallationState =
  | 'native'
  | 'verified'
  | 'missing'
  | 'unverified'
  | 'not_implemented';

export interface HarnessAdapterCatalogEntry {
  descriptor: HarnessAdapterDescriptor;
  installation: HarnessAdapterInstallationState;
  campaign_order: number;
  profile_ids?: readonly string[];
}

export interface RemoteHarnessCapabilitiesPayload {
  execution_owner: 'protocol_host';
  unmanaged_live_attach: {
    supported: false;
    reason: string;
  };
  adapter_profiles: typeof EXTERNAL_ADAPTER_PROFILE_IDS;
  harness_adapters: HarnessAdapterCatalogEntry[];
}

const UNMANAGED_ATTACH_REASON =
  'Unmanaged live attach to third-party TUIs is not supported on the shared-owner path.';

function disabledCapabilities(): HarnessCapabilityFlags {
  return {
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
}

function stubDescriptor(id: HarnessAdapterId, displayName: string): HarnessAdapterDescriptor {
  return {
    id,
    displayName,
    version: 'not-implemented',
    capabilities: disabledCapabilities(),
    unsupportedReason: 'Adapter campaign slice not yet implemented on the shared-owner contract.',
  };
}

const STUB_DISPLAY: Record<
  Exclude<HarnessAdapterId, 'babel-native' | 'command-code' | 'opencode' | 'antigravity'>,
  string
> = {
  'claude-code': 'Claude Code CLI',
  codex: 'Codex CLI',
};

export async function buildHarnessAdapterCatalog(options?: {
  commandCodeProbe?: CommandCodeInstallProbe;
  openCodeProbe?: OpenCodeInstallProbe;
}): Promise<HarnessAdapterCatalogEntry[]> {
  const commandCodeProbe =
    options?.commandCodeProbe ?? (await probeCommandCodeInstallation());
  const openCodeProbe = options?.openCodeProbe ?? (await probeOpenCodeInstallation());
  const commandCodeDescriptor = buildCommandCodeAdapterDescriptor(commandCodeProbe);
  const openCodeDescriptor = buildOpenCodeAdapterDescriptor(openCodeProbe);
  const antigravityDescriptor = buildAntigravityAdapterDescriptor();
  const commandCodeInstallation: HarnessAdapterInstallationState =
    commandCodeProbe.state === 'verified'
      ? 'verified'
      : commandCodeProbe.state === 'missing'
        ? 'missing'
        : 'unverified';
  const openCodeInstallation: HarnessAdapterInstallationState =
    openCodeProbe.state === 'verified'
      ? 'verified'
      : openCodeProbe.state === 'missing'
        ? 'missing'
        : 'unverified';
  const byId = new Map<HarnessAdapterId, HarnessAdapterCatalogEntry>();
  byId.set('babel-native', {
    descriptor: BABEL_NATIVE_ADAPTER,
    installation: 'native',
    campaign_order: 0,
  });
  byId.set('command-code', {
    descriptor: commandCodeDescriptor,
    installation: commandCodeInstallation,
    campaign_order: 1,
    profile_ids: [EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat],
  });
  byId.set('opencode', {
    descriptor: openCodeDescriptor,
    installation: openCodeInstallation,
    campaign_order: 2,
    profile_ids: [EXTERNAL_ADAPTER_PROFILE_IDS.openCodeGo],
  });
  byId.set('antigravity', {
    descriptor: antigravityDescriptor,
    installation: 'not_implemented',
    campaign_order: 3,
  });

  let order = 4;
  for (const id of EXTERNAL_ADAPTER_CAMPAIGN_ORDER) {
    if (id === 'command-code' || id === 'opencode' || id === 'antigravity') continue;
    const profileIds = undefined;
    const displayName = STUB_DISPLAY[id as keyof typeof STUB_DISPLAY];
    byId.set(id, {
      descriptor: stubDescriptor(id, displayName),
      installation: 'not_implemented',
      campaign_order: order,
      ...(profileIds ? { profile_ids: profileIds } : {}),
    });
    order += 1;
  }

  return [...byId.values()].sort((a, b) => a.campaign_order - b.campaign_order);
}

export async function buildRemoteHarnessCapabilities(): Promise<RemoteHarnessCapabilitiesPayload> {
  return {
    execution_owner: 'protocol_host',
    unmanaged_live_attach: {
      supported: false,
      reason: UNMANAGED_ATTACH_REASON,
    },
    adapter_profiles: EXTERNAL_ADAPTER_PROFILE_IDS,
    harness_adapters: await buildHarnessAdapterCatalog(),
  };
}
