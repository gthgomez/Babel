import { ChatEngine } from '../agent/chatEngine.js';
import type { ChatEvent } from '../agent/chatEngineContracts.js';
import type { SessionDescriptor } from '../executor/contracts.js';
import { writeSessionDescriptor } from '../services/threadStore/sessionDescriptor.js';
import { getRemoteSurface } from './remoteApproval.js';
import type { ClaudeCodeAgentRuntimeRegistry } from './claudeCodeAgentRuntime.js';
import { syncClaudeNativeSessionToDescriptor } from './claudeCodeDescriptorSync.js';

export interface ClaudeCodeHarnessEngineOptions {
  descriptor: SessionDescriptor;
  registry: ClaudeCodeAgentRuntimeRegistry;
}

function* drainPendingEvents(session: { pendingEvents: ChatEvent[] }): Generator<ChatEvent, void, void> {
  while (session.pendingEvents.length > 0) {
    yield session.pendingEvents.shift()!;
  }
}

export function createClaudeCodeHarnessEngine(options: ClaudeCodeHarnessEngineOptions): ChatEngine {
  const registry = options.registry;
  const descriptor = options.descriptor;
  const engine = new ChatEngine({
    inferenceOwner: 'external-harness',
    task: descriptor.task ?? 'claude-code-harness',
    projectRoot: descriptor.projectRoot,
    executionProfile: 'chat',
    runtimeMode: 'direct',
  });
  engine.assignRunId(descriptor.threadId);

  let cancelRequested = false;
  let cancelNotified = false;
  let activeTurnId = '';

  engine.submitMessageStream = async function* (message: string) {
    cancelRequested = false;
    cancelNotified = false;
    const surface = getRemoteSurface();
    if (!surface) {
      yield { type: 'failed', error: 'Claude Code harness requires remote approval surface' };
      return;
    }

    if (!registry.getAdmitted(descriptor.threadId)) {
      yield { type: 'failed', error: 'Claude Code session is not admitted' };
      return;
    }

    const session = await registry.ensureSession(descriptor);

    if (registry.isCancelPending(descriptor) || session.pendingCancel) {
      registry.clearCancelPending(descriptor);
      yield { type: 'cancelled' };
      return;
    }

    activeTurnId = surface.turnId;
    writeSessionDescriptor(descriptor);

    const runPromise = registry.runTurn({
      descriptor,
      message,
      binding: {
        threadId: surface.threadId,
        turnId: surface.turnId,
        cwd: descriptor.projectRoot,
        broker: surface.broker,
        ...(surface.notify ? { notify: surface.notify } : {}),
      },
    });

    yield { type: 'thinking' };

    let settled = false;
    try {
      while (!settled) {
        for (const event of drainPendingEvents(session)) {
          yield event;
          if (event.type === 'done' || event.type === 'failed' || event.type === 'cancelled') {
            settled = true;
            break;
          }
        }
        if (settled) break;

        if (cancelRequested && !cancelNotified) {
          if (registry.requestInterrupt(descriptor, activeTurnId)) {
            cancelNotified = true;
          }
        }

        const raced = await Promise.race([
          runPromise.then(() => 'done' as const),
          new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), 20)),
        ]);
        if (raced !== 'done') continue;
        await runPromise;
        for (const event of drainPendingEvents(session)) {
          yield event;
        }
        settled = true;
      }
    } finally {
      const nativeId = registry.consumeNativeSessionId(descriptor.threadId);
      if (nativeId) {
        const synced = syncClaudeNativeSessionToDescriptor({
          registry,
          descriptor,
          nativeSessionId: nativeId,
        });
        if (synced) writeSessionDescriptor(descriptor);
      }
    }
  };

  engine.cancel = () => {
    cancelRequested = true;
    registry.markCancelPending(descriptor);
    if (activeTurnId) {
      registry.requestInterrupt(descriptor, activeTurnId);
    }
  };

  return engine;
}
