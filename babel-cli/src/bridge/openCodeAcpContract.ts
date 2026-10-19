/**
 * OpenCode ACP contract for Babel own-CLI harness (not Command Code).
 *
 * Authoritative behavior: https://opencode.ai/v2/docs/cli/acp
 * Implementation reference (retrievable): anomalyco/opencode @ pin below — see
 * `babel-cli/test/fixtures/opencode-acp-source-pin.json` for paths and revision notes.
 */

import sourcePin from '../../test/fixtures/opencode-acp-source-pin.json' with { type: 'json' };

/** Git commit + paths used to derive strict test peers and permission binding. */
export const OPENCODE_ACP_SOURCE_PIN = Object.freeze({
  repository: sourcePin.repository,
  commit: sourcePin.commit,
  documentation: sourcePin.documentation,
  implementationPaths: Object.freeze([...sourcePin.implementation_paths]),
});

/** ACP protocol version required by documented OpenCode `opencode acp` agent. */
export const OPENCODE_ACP_PROTOCOL_VERSION = 1;

/**
 * `initialize` agentCapabilities object from OpenCode ACP protocol reference (v2 docs).
 * Used by the strict test peer only; production learns capabilities from the live agent.
 */
export const OPENCODE_ACP_DOCUMENTED_AGENT_CAPABILITIES = Object.freeze({
  loadSession: true,
  mcpCapabilities: { http: true, sse: false },
  promptCapabilities: { embeddedContext: true, image: true },
  sessionCapabilities: {
    additionalDirectories: {},
    close: {},
    delete: {},
    fork: {},
    list: {},
    resume: {},
  },
});

/** Production child argv after the resolved `opencode` executable. */
export const OPENCODE_ACP_LAUNCH_ARGS = Object.freeze(['acp'] as const);
