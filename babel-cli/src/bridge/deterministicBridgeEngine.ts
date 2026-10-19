/**
 * Loopback-only deterministic ChatEngine for acceptance tests (no provider calls).
 * Enabled only when `BABEL_BRIDGE_DETERMINISTIC_ENGINE=1` is set on the bridge process.
 */

import { ChatEngine } from '../agent/chatEngine.js';
import type { SessionDescriptor } from '../executor/contracts.js';
import type { ProtocolHostState } from '../protocol/client/host.js';

export function isDeterministicBridgeEngineEnabled(): boolean {
  return process.env['BABEL_BRIDGE_DETERMINISTIC_ENGINE'] === '1';
}

export function createDeterministicBridgeEngineFactory(): ProtocolHostState['engineFactory'] {
  return (descriptor: SessionDescriptor) => {
    const engine = new ChatEngine({
      task: descriptor.task ?? 'deterministic-bridge',
      projectRoot: descriptor.projectRoot,
      executionProfile: 'chat',
    });
    engine.submitMessageStream = async function* (message: string) {
      yield { type: 'thinking' };
      yield { type: 'answer_chunk', text: message.slice(0, 32) || 'ok' };
      yield {
        type: 'done',
        answer: message.trim() || 'ok',
        usage: {
          totalCostUSD: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 0,
          modelBreakdown: {},
        },
      };
    } as ChatEngine['submitMessageStream'];
    return engine;
  };
}
