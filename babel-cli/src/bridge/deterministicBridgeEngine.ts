/**
 * Deterministic ChatEngine seam injected only by the test-owned acceptance bridge launcher.
 * Ordinary `babel remote serve` never imports this factory.
 */

import { ChatEngine } from '../agent/chatEngine.js';
import { ACCEPTANCE_BRIDGE_KIND } from './acceptanceBridge.js';
import type { SessionDescriptor } from '../executor/contracts.js';
import type { ProtocolHostState } from '../protocol/client/host.js';

export function createDeterministicBridgeEngineFactory(): ProtocolHostState['engineFactory'] {
  return (descriptor: SessionDescriptor) => {
    const engine = new ChatEngine({
      inferenceOwner: 'external-harness',
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
        status: 'completed',
        fixture_execution: true,
        fixture_kind: ACCEPTANCE_BRIDGE_KIND,
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
