import { ChatEngine } from '../agent/chatEngine.js';
import type { SessionDescriptor } from '../executor/contracts.js';
import type { ProtocolHostState } from '../protocol/client/host.js';
import { buildPreparedTurn } from '../executor/modeAdapters.js';
import { createCommandCodeHarnessEngine } from './commandCodeHarnessEngine.js';
import type { CommandCodeAcpRuntimeRegistry } from './commandCodeAcpRuntime.js';
import { probeCommandCodeInstallation } from './commandCodeCliDiscovery.js';

function defaultNativeEngine(descriptor: SessionDescriptor): ChatEngine {
  const prepared = buildPreparedTurn(descriptor);
  const engine = new ChatEngine({
    task: prepared.task,
    projectRoot: prepared.projectRoot,
    runtimeMode: 'direct',
    ...(prepared.model !== 'default' ? { model: prepared.model } : {}),
    ...(prepared.provider !== 'default' ? { provider: prepared.provider } : {}),
    executionProfile: prepared.mode === 'plan' ? 'plan' : prepared.mode === 'deep' ? 'deep' : 'chat',
    hardPlanMode: prepared.mode === 'plan',
  });
  engine.assignRunId(descriptor.threadId);
  return engine;
}

/**
 * Protocol-host engine router: native ChatEngine vs Command Code own-CLI ACP adapter.
 */
export function createHarnessAwareEngineFactory(
  commandCodeRegistry: CommandCodeAcpRuntimeRegistry,
): ProtocolHostState['engineFactory'] {
  return (descriptor: SessionDescriptor) => {
    if (descriptor.harness_adapter_id === 'command-code') {
      return createCommandCodeHarnessEngine({ descriptor, registry: commandCodeRegistry });
    }
    return defaultNativeEngine(descriptor);
  };
}

export async function assertCommandCodeHarnessAvailable(): Promise<void> {
  const probe = await probeCommandCodeInstallation();
  if (probe.state !== 'verified') {
    throw new Error('COMMAND_CODE_HARNESS_UNAVAILABLE');
  }
}
