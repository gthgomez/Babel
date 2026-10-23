import { ChatEngine } from '../agent/chatEngine.js';
import type { SessionDescriptor } from '../executor/contracts.js';
import type { ProtocolHostState } from '../protocol/client/host.js';
import { buildPreparedTurn } from '../executor/modeAdapters.js';
import { createCommandCodeHarnessEngine } from './commandCodeHarnessEngine.js';
import { createOpenCodeHarnessEngine } from './openCodeHarnessEngine.js';
import { createClaudeCodeHarnessEngine } from './claudeCodeHarnessEngine.js';
import type { CommandCodeAcpRuntimeRegistry } from './commandCodeAcpRuntime.js';
import type { OpenCodeAcpRuntimeRegistry } from './openCodeAcpRuntime.js';
import type { ClaudeCodeAgentRuntimeRegistry } from './claudeCodeAgentRuntime.js';
import { probeCommandCodeInstallation } from './commandCodeCliDiscovery.js';
import { probeOpenCodeInstallation } from './openCodeCliDiscovery.js';

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
  openCodeRegistry: OpenCodeAcpRuntimeRegistry,
  claudeCodeRegistry?: ClaudeCodeAgentRuntimeRegistry,
): ProtocolHostState['engineFactory'] {
  return (descriptor: SessionDescriptor) => {
    if (descriptor.harness_adapter_id === 'command-code') {
      return createCommandCodeHarnessEngine({ descriptor, registry: commandCodeRegistry });
    }
    if (descriptor.harness_adapter_id === 'opencode') {
      return createOpenCodeHarnessEngine({ descriptor, registry: openCodeRegistry });
    }
    if (descriptor.harness_adapter_id === 'claude-code') {
      if (!claudeCodeRegistry) {
        throw new Error('CLAUDE_CODE_REGISTRY_UNAVAILABLE');
      }
      return createClaudeCodeHarnessEngine({ descriptor, registry: claudeCodeRegistry });
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

export async function assertOpenCodeHarnessAvailable(): Promise<void> {
  const probe = await probeOpenCodeInstallation();
  if (probe.state !== 'verified') {
    throw new Error('OPENCODE_HARNESS_UNAVAILABLE');
  }
}
