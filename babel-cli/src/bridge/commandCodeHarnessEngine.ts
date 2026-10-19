import { ChatEngine } from '../agent/chatEngine.js';
import type { SessionDescriptor } from '../executor/contracts.js';
import { writeSessionDescriptor } from '../services/threadStore/sessionDescriptor.js';
import { getRemoteSurface } from './remoteApproval.js';
import type { CommandCodeAcpRuntimeRegistry } from './commandCodeAcpRuntime.js';

export interface CommandCodeHarnessEngineOptions {
  descriptor: SessionDescriptor;
  registry: CommandCodeAcpRuntimeRegistry;
}

const TURN_WAIT_MS = Number(process.env['BABEL_COMMAND_CODE_TURN_WAIT_MS'] ?? 8_000);

export function createCommandCodeHarnessEngine(options: CommandCodeHarnessEngineOptions): ChatEngine {
  const registry = options.registry;
  const descriptor = options.descriptor;
  const engine = new ChatEngine({
    task: descriptor.task ?? 'command-code-harness',
    projectRoot: descriptor.projectRoot,
    executionProfile: 'chat',
    runtimeMode: 'direct',
  });
  engine.assignRunId(descriptor.threadId);

  let cancelRequested = false;

  engine.submitMessageStream = async function* (message: string) {
    cancelRequested = false;
    const surface = getRemoteSurface();
    if (!surface) {
      yield { type: 'failed', error: 'Command Code harness requires remote approval surface' };
      return;
    }

    const session = await registry.ensureSession(descriptor);
    session.turnState = { textBuffer: [], terminalEmitted: false };
    session.pendingEvents = [];
    session.permissionBinding = {
      threadId: surface.threadId,
      turnId: surface.turnId,
      cwd: descriptor.projectRoot,
      broker: surface.broker,
      ...(surface.notify ? { notify: surface.notify } : {}),
    };

    try {
      writeSessionDescriptor(descriptor);
      const transport = registry.transportForThread(descriptor);

      await transport.call('session/prompt', {
        sessionId: session.nativeSessionId,
        prompt: [{ type: 'text', text: message }],
      });

      yield { type: 'thinking' };

      let settled = false;
      const deadline = Date.now() + TURN_WAIT_MS;
      while (!settled && Date.now() < deadline) {
        while (session.pendingEvents.length > 0) {
          const event = session.pendingEvents.shift()!;
          yield event;
          if (event.type === 'done' || event.type === 'failed' || event.type === 'cancelled') {
            settled = true;
            break;
          }
        }
        if (settled) break;
        if (cancelRequested) {
          registry.requestCancel(descriptor);
        }
        if (session.processDead) {
          yield { type: 'failed', error: 'Command Code ACP process exited during turn' };
          return;
        }
        await new Promise<void>((resolve) => {
          session.wake = resolve;
          setTimeout(resolve, 20);
        });
        session.wake = null;
      }
      if (!settled) {
        yield {
          type: 'failed',
          error: cancelRequested
            ? 'Cancel was requested but no authoritative terminal was observed'
            : 'Timed out waiting for Command Code turn terminal',
        };
      }
    } finally {
      session.permissionBinding = null;
    }
  };

  engine.cancel = () => {
    cancelRequested = true;
    const session = registry.getBoundSession(descriptor);
    session?.wake?.();
    registry.requestCancel(descriptor);
  };

  return engine;
}
