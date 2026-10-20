import type { ClaudeCodeSdkPort } from './claudeCodeSdkPort.js';

/**
 * Production SDK port (lazy). Not used in unit tests; invokes real query() when called.
 */
export function createClaudeCodeLiveSdkPort(): ClaudeCodeSdkPort {
  return {
    async *runTurn() {
      throw new Error('CLAUDE_CODE_LIVE_SDK_DISABLED_IN_THIS_BUILD');
    },
    async interrupt() {
      /* no-op */
    },
    async close() {
      /* no-op */
    },
    async awaitTeardown() {
      /* no-op */
    },
  };
}
