import { ChatEngine } from '../agent/chatEngine.js';
import type { ChatEvent } from '../agent/chatEngineContracts.js';
import type { SessionDescriptor } from '../executor/contracts.js';
import { writeSessionDescriptor } from '../services/threadStore/sessionDescriptor.js';
import { getRemoteSurface } from './remoteApproval.js';
import { mapPromptTerminalFromStopReason, type AcpTurnMapState } from './commandCodeAcpEventMap.js';
import type { CommandCodeAcpRuntimeRegistry } from './commandCodeAcpRuntime.js';

export interface CommandCodeHarnessEngineOptions {
  descriptor: SessionDescriptor;
  registry: CommandCodeAcpRuntimeRegistry;
}

function* drainPendingEvents(session: { pendingEvents: ChatEvent[] }): Generator<ChatEvent, void, void> {
  while (session.pendingEvents.length > 0) {
    yield session.pendingEvents.shift()!;
  }
}

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
  let cancelNotified = false;

  engine.submitMessageStream = async function* (message: string) {
    cancelRequested = false;
    cancelNotified = false;
    const surface = getRemoteSurface();
    if (!surface) {
      yield { type: 'failed', error: 'Command Code harness requires remote approval surface' };
      return;
    }

    const session = await registry.ensureSession(descriptor);
    for (const replay of session.replayEvents) {
      yield replay;
    }
    session.replayEvents = [];

    const turnState: AcpTurnMapState = {
      textBuffer: [],
      terminalEmitted: false,
      promptAdmitted: false,
    };
    session.turnState = turnState;
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
      const codec = transport.negotiatedCodec();
      if (!codec) {
        yield { type: 'failed', error: 'Command Code ACP not negotiated' };
        return;
      }

      turnState.promptAdmitted = true;
      let promptResult: Record<string, unknown> | undefined;
      const promptDone = transport
        .call('session/prompt', {
          sessionId: session.nativeSessionId,
          prompt: [{ type: 'text', text: message }],
          ...(codec.protocolVersion === 1 ? { mcpServers: [] } : {}),
        })
        .then((result) => {
          promptResult = result;
        });

      yield { type: 'thinking' };

      let settled = false;
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
          registry.requestCancel(descriptor);
          cancelNotified = true;
        }

        if (session.processDead) {
          yield { type: 'failed', error: 'Command Code ACP process exited during turn' };
          return;
        }

        const raced = await Promise.race([
          promptDone.then(() => 'prompt' as const),
          new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), 20)),
        ]);
        if (raced === 'prompt') {
          await promptDone;
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
          for (const event of drainPendingEvents(session)) {
            yield event;
            if (event.type === 'done' || event.type === 'failed' || event.type === 'cancelled') {
              settled = true;
            }
          }
          if (!settled && !turnState.terminalEmitted) {
            const stopReason =
              typeof promptResult?.stopReason === 'string' ? promptResult.stopReason : 'end_turn';
            for (const event of mapPromptTerminalFromStopReason(
              turnState,
              codec.protocolVersion,
              stopReason,
            )) {
              yield event;
              settled = true;
            }
          }
          break;
        }
      }
    } finally {
      session.permissionBinding = null;
      turnState.promptAdmitted = false;
    }
  };

  engine.cancel = () => {
    cancelRequested = true;
    const session = registry.getBoundSession(descriptor);
    session?.wake?.();
    if (!cancelNotified) {
      registry.requestCancel(descriptor);
      cancelNotified = true;
    }
  };

  return engine;
}
