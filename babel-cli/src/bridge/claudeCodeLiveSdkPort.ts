import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

import type {
  ClaudeCodeSdkPort,
  ClaudeCodeTurnRequest,
  ClaudeSdkStreamMessage,
} from './claudeCodeSdkPort.js';

interface ActiveClaudeQuery {
  query: Query;
  teardown: Promise<void>;
  closed: boolean;
}

function mapSdkMessage(msg: SDKMessage): ClaudeSdkStreamMessage | null {
  if (msg.type === 'assistant') {
    const parts = msg.message.content ?? [];
    let text = '';
    for (const block of parts) {
      if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text') {
        const candidate = (block as { text?: string }).text;
        if (typeof candidate === 'string') text += candidate;
      }
    }
    if (!text) return null;
    return { type: 'assistant', text };
  }
  if (msg.type === 'result') {
    if (msg.subtype === 'success') {
      return {
        type: 'result',
        subtype: 'success',
        result: msg.result,
        total_cost_usd: msg.total_cost_usd,
        session_id: msg.session_id,
        is_error: msg.is_error,
      };
    }
    return {
      type: 'result',
      subtype: 'error',
      result: msg.errors?.join('; ') ?? 'Claude SDK error result',
      total_cost_usd: msg.total_cost_usd,
      session_id: msg.session_id,
      is_error: true,
    };
  }
  return null;
}

export function createClaudeCodeLiveSdkPort(): ClaudeCodeSdkPort {
  const sessions = new Map<string, ActiveClaudeQuery>();

  const awaitSessionTeardown = async (sessionKey: string): Promise<void> => {
    const active = sessions.get(sessionKey);
    if (!active) return;
    await active.teardown;
    sessions.delete(sessionKey);
  };

  return {
    async *runTurn(request: ClaudeCodeTurnRequest): AsyncIterable<ClaudeSdkStreamMessage> {
      const key = request.admitted.admission_digest;
      await awaitSessionTeardown(key);

      const abortController = new AbortController();
      const q = query({
        prompt: request.message,
        options: {
          cwd: request.admitted.cwd,
          projectConfigRoot: request.admitted.harness_config_root,
          model: request.admitted.harness_model_profile,
          pathToClaudeCodeExecutable: request.admitted.cli_executable_path,
          settingSources: request.policy.settingSources,
          permissionMode: request.policy.permissionMode,
          permissionPrompts: request.policy.permissionPrompts,
          managedSettings: request.policy.managedSettings as import('@anthropic-ai/claude-agent-sdk').Settings,
          env: request.childEnv,
          abortController,
          canUseTool: async (toolName, input) => {
            const decision = await request.canUseTool({ toolName, input });
            if (decision.behavior === 'allow') {
              return {
                behavior: 'allow',
                ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
              };
            }
            return { behavior: 'deny', message: decision.message };
          },
          ...(request.admitted.harness_native_session_id
            ? { resume: request.admitted.harness_native_session_id }
            : {}),
        },
      });

      let resolveTeardown: () => void = () => {};
      const teardown = new Promise<void>((resolve) => {
        resolveTeardown = resolve;
      });
      sessions.set(key, { query: q, teardown, closed: false });

      try {
        for await (const msg of q) {
          const mapped = mapSdkMessage(msg);
          if (mapped) yield mapped;
        }
      } finally {
        resolveTeardown();
        sessions.delete(key);
      }
    },
    async interrupt(sessionKey: string): Promise<void> {
      const active = sessions.get(sessionKey);
      if (!active || active.closed) return;
      await active.query.interrupt();
    },
    async close(sessionKey: string): Promise<void> {
      const active = sessions.get(sessionKey);
      if (!active || active.closed) return;
      active.closed = true;
      active.query.close();
    },
    async awaitTeardown(sessionKey: string): Promise<void> {
      await awaitSessionTeardown(sessionKey);
    },
  };
}
