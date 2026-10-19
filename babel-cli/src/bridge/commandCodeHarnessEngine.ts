import { ChatEngine } from '../agent/chatEngine.js';
import type { AgentAction } from '../agent/actions.js';
import type { SessionDescriptor } from '../executor/contracts.js';
import { writeSessionDescriptor } from '../services/threadStore/sessionDescriptor.js';
import { getRemoteSurface } from './remoteApproval.js';
import {
  globalCommandCodeAcpRuntime,
  type CommandCodeAcpRuntimeRegistry,
} from './commandCodeAcpRuntime.js';

export interface CommandCodeHarnessEngineOptions {
  descriptor: SessionDescriptor;
  registry?: CommandCodeAcpRuntimeRegistry;
}

export function createCommandCodeHarnessEngine(options: CommandCodeHarnessEngineOptions): ChatEngine {
  const registry = options.registry ?? globalCommandCodeAcpRuntime;
  const descriptor = options.descriptor;
  const engine = new ChatEngine({
    task: descriptor.task ?? 'command-code-harness',
    projectRoot: descriptor.projectRoot,
    executionProfile: 'chat',
    runtimeMode: 'direct',
  });
  engine.assignRunId(descriptor.threadId);

  engine.submitMessageStream = async function* (message: string) {
    const session = await registry.ensureSession(descriptor);
    session.turnState.textBuffer = [];
    session.turnState.cancelRequested = false;
    delete session.turnState.usage;
    session.pendingEvents = [];

    session.permissionHandler = async ({ params }) => {
      const surface = getRemoteSurface();
      if (!surface) return { outcome: 'cancelled' };
      const optionsList = Array.isArray(params.options) ? params.options : [];
      const allow = optionsList.find(
        (row) => row && typeof row === 'object' && (row as { kind?: string }).kind === 'allow_once',
      ) as { optionId?: string } | undefined;
      const title = typeof params.title === 'string' ? params.title : 'Command Code permission';
      const action: AgentAction = {
        type: 'ask_approval',
        reason: title,
        requested_action: { type: 'run_command', command: title, cwd: descriptor.projectRoot },
      };
      const allowed = await surface.broker.requestAllowOnce({
        action,
        thread_id: surface.threadId,
        turn_id: surface.turnId,
        cwd: descriptor.projectRoot,
        ...(surface.notify ? { notify: surface.notify } : {}),
      });
      if (!allowed) return { outcome: 'cancelled' };
      const optionId = allow?.optionId ?? String(optionsList[0]?.optionId ?? 'allow_once');
      return { outcome: 'selected', optionId };
    };

    writeSessionDescriptor(descriptor);
    const transport = registry.transportForThread(descriptor);

    await transport.call('session/prompt', {
      sessionId: session.nativeSessionId,
      prompt: [{ type: 'text', text: message }],
    });

    yield { type: 'thinking' };

    let settled = false;
    while (!settled) {
      while (session.pendingEvents.length > 0) {
        const event = session.pendingEvents.shift()!;
        yield event;
        if (event.type === 'done' || event.type === 'failed' || event.type === 'cancelled') {
          settled = true;
          break;
        }
      }
      if (settled) break;
      if (session.turnState.cancelRequested) {
        try {
          await registry.cancelPrompt(descriptor);
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => {
        session.wake = resolve;
        setTimeout(resolve, 25);
      });
      session.wake = null;
      if (session.turnState.cancelRequested && session.pendingEvents.length === 0) {
        yield { type: 'cancelled' };
        settled = true;
      }
    }
    session.permissionHandler = null;
  };

  engine.cancel = () => {
    const session = registry.getBoundSession(descriptor);
    if (session) {
      session.turnState.cancelRequested = true;
      session.wake?.();
      void registry.cancelPrompt(descriptor).catch(() => undefined);
    }
  };

  return engine;
}
