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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCommandCodePromptError(promptError: unknown): string {
  const text = promptError instanceof Error ? promptError.message : String(promptError);
  if (text.includes('COMMAND_CODE_ACP_RPC_TIMEOUT:session/prompt')) {
    return 'Command Code prompt observation timed out; owned runtime stopped';
  }
  if (text.startsWith('COMMAND_CODE_ACP_ERROR:')) {
    const withoutPrefix = text.slice('COMMAND_CODE_ACP_ERROR:'.length);
    const codeEnd = withoutPrefix.indexOf(':');
    const code = codeEnd >= 0 ? withoutPrefix.slice(0, codeEnd) : 'unknown';
    const message = codeEnd >= 0 ? withoutPrefix.slice(codeEnd + 1) : withoutPrefix;
    return `Command Code prompt rejected (${code}): ${message}`;
  }
  return `Command Code prompt failed: ${text}`;
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
    registry.persistReplayHistory(descriptor);

    if (registry.isCancelPending(descriptor) || session.pendingCancel) {
      registry.clearCancelPending(descriptor);
      yield { type: 'cancelled' };
      return;
    }

    let sessionCostBaselineUSD: number | undefined;
    if (session.sessionCostCurrencyKnown && session.sessionCumulativeCostUSD !== undefined) {
      sessionCostBaselineUSD = session.sessionCumulativeCostUSD;
    }
    const turnState: AcpTurnMapState = {
      textBuffer: [],
      terminalEmitted: false,
      promptAdmitted: false,
      ...(sessionCostBaselineUSD !== undefined ? { sessionCostBaselineUSD } : {}),
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

      if (registry.isCancelPending(descriptor) || session.pendingCancel) {
        registry.requestCancel(descriptor);
        cancelNotified = true;
        yield { type: 'cancelled' };
        return;
      }

      let promptResult: Record<string, unknown> | undefined;
      let promptError: unknown;
      turnState.promptAdmitted = true;
      const promptDone = transport
        .call('session/prompt', {
          sessionId: session.nativeSessionId,
          prompt: [{ type: 'text', text: message }],
          mcpServers: [],
        })
        .then((result) => {
          promptResult = result;
        })
        .catch((error) => {
          promptError = error;
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
          if (registry.requestCancel(descriptor)) {
            cancelNotified = true;
          }
        }

        if (session.processDead) {
          yield { type: 'failed', error: 'Command Code ACP process exited during turn' };
          return;
        }

        const raced = await Promise.race([
          promptDone.then(() => 'prompt' as const),
          new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), 20)),
        ]);
        if (raced !== 'prompt') continue;

        await promptDone;
        if (promptError) {
          const messageText = String(promptError);
          if (messageText.includes('COMMAND_CODE_ACP_RPC_TIMEOUT:session/prompt')) {
            await registry.forceStopForThread(descriptor);
            while (!session.processDead) {
              await sleep(20);
            }
          }
          yield { type: 'failed', error: formatCommandCodePromptError(promptError) };
          return;
        }

        for (const event of drainPendingEvents(session)) {
          yield event;
          if (event.type === 'done' || event.type === 'failed' || event.type === 'cancelled') {
            settled = true;
          }
        }
        if (settled) break;

        if (!turnState.terminalEmitted) {
          const stopReason = promptResult?.stopReason;
          if (typeof stopReason !== 'string' || !stopReason) {
            yield { type: 'failed', error: 'Command Code prompt missing stopReason' };
            return;
          }
          for (const event of mapPromptTerminalFromStopReason(turnState, codec.protocolVersion, stopReason)) {
            yield event;
            settled = true;
          }
        }
        break;
      }
    } finally {
      session.permissionBinding = null;
      turnState.promptAdmitted = false;
      if (turnState.lastCumulativeCostUSD !== undefined) {
        session.sessionCumulativeCostUSD = turnState.lastCumulativeCostUSD;
        session.sessionCostCurrencyKnown = true;
      } else if (turnState.usage && !turnState.usage.costComplete) {
        session.sessionCostCurrencyKnown = false;
      }
      registry.clearCancelPending(descriptor);
    }
  };

  engine.cancel = () => {
    cancelRequested = true;
    registry.markCancelPending(descriptor);
    const session = registry.getBoundSession(descriptor);
    session?.wake?.();
    if (!cancelNotified && registry.requestCancel(descriptor)) {
      cancelNotified = true;
    }
  };

  return engine;
}
