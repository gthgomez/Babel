import type {
  ClaudeCodeSdkPort,
  ClaudeCodeTurnRequest,
  ClaudeSdkStreamMessage,
} from './claudeCodeSdkPort.js';

export function createClaudeCodeFakeSdkPort(
  script: (req: ClaudeCodeTurnRequest) => ClaudeSdkStreamMessage[],
): ClaudeCodeSdkPort {
  const sessions = new Map<string, { interrupted: boolean; closed: boolean }>();

  return {
    async *runTurn(request: ClaudeCodeTurnRequest): AsyncIterable<ClaudeSdkStreamMessage> {
      const key = request.admitted.admission_digest;
      if (!sessions.has(key)) sessions.set(key, { interrupted: false, closed: false });
      const state = sessions.get(key)!;
      if (state.closed) return;
      for (const msg of script(request)) {
        if (state.interrupted) {
          yield { type: 'result', subtype: 'error', is_error: true, result: 'interrupted' };
          return;
        }
        yield msg;
      }
    },
    async interrupt(sessionKey: string): Promise<void> {
      const state = sessions.get(sessionKey);
      if (state) state.interrupted = true;
    },
    async close(sessionKey: string): Promise<void> {
      const state = sessions.get(sessionKey);
      if (state) state.closed = true;
    },
    async awaitTeardown(sessionKey: string): Promise<void> {
      const state = sessions.get(sessionKey);
      if (state) state.closed = true;
    },
  };
}
