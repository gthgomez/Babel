import type { ChatEngineStreamingLoopHost } from './chatEngineContracts.js';
import { checkpointParityEventLog } from './chatEngineParityBridge.js';
import { recordAssistantMessage } from './threadEventLog.js';

/** Keep controller advice visible across native rebuilds without creating user authority. */
export function recordChatHarnessFeedback(
  host: Pick<ChatEngineStreamingLoopHost, 'conversation' | 'parity' | 'engineRunDir'>,
  content: string,
): void {
  const metadata = {
    name: 'harness_feedback',
    provenance: 'controller' as const,
    authoritative: false,
  };
  host.conversation.push({ role: 'assistant', content, ...metadata });
  if (host.parity.turnId) {
    recordAssistantMessage(host.parity.eventLog, host.parity.turnId, content, metadata);
    checkpointParityEventLog(host.parity, host.engineRunDir);
  }
}
