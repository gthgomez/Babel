import type { HarnessAdapterDescriptor } from './harnessAdapterContract.js';
import {
  OPENCODE_ATTACH_LIVE_UNSUPPORTED_REASON,
  OPENCODE_BASE_CAPABILITIES,
} from './harnessAdapterContract.js';
import type { OpenCodeInstallProbe } from './openCodeCliDiscovery.js';
import {
  OPENCODE_ACP_PROTOCOL_VERSION,
  type OpenCodeFixtureLine,
  type OpenCodeWireMessage,
  parseOpenCodeLine,
  serializeOpenCodeLine,
} from './openCodeProtocol.js';

export interface OpenCodeSessionIo {
  write(line: string): void;
  readLine(): Promise<string>;
}

/**
 * Replay a deterministic stdin/stdout transcript for Babel-managed own-CLI sessions.
 * Does not open network sockets or provider credentials.
 */
export async function replayOpenCodeFixture(
  fixture: readonly OpenCodeFixtureLine[],
  io: OpenCodeSessionIo,
): Promise<void> {
  let stdinIndex = 0;
  for (const step of fixture) {
    if (step.direction === 'stdin') {
      const line = await io.readLine();
      const parsed = parseOpenCodeLine(line);
      const expected = step.message;
      if (parsed.method !== expected.method || parsed.id !== expected.id) {
        throw new Error('OPENCODE_FIXTURE_STDIN_MISMATCH');
      }
      if (step.expectParams !== undefined) {
        const actualParams = parsed.params ?? {};
        if (JSON.stringify(actualParams) !== JSON.stringify(step.expectParams)) {
          throw new Error('OPENCODE_FIXTURE_STDIN_PARAMS_MISMATCH');
        }
      }
      stdinIndex += 1;
      continue;
    }
    io.write(serializeOpenCodeLine(step.message));
  }
  const pendingStdin = fixture.filter((line) => line.direction === 'stdin').length;
  if (stdinIndex !== pendingStdin) {
    throw new Error('OPENCODE_FIXTURE_INCOMPLETE');
  }
}

export function buildOpenCodeAdapterDescriptor(
  probe: OpenCodeInstallProbe,
): HarnessAdapterDescriptor {
  const version =
    probe.state === 'verified'
      ? probe.version ?? 'verified'
      : probe.state === 'missing'
        ? 'not-installed'
        : 'unverified';

  const enabled = probe.state === 'verified';
  return {
    id: 'opencode',
    displayName: 'OpenCode CLI',
    version,
    capabilities: {
      ...OPENCODE_BASE_CAPABILITIES,
      catalog: enabled,
      start: enabled,
      readHistory: false,
      resumeStopped: enabled,
      stream: enabled,
      steer: false,
      cancel: enabled,
      approve: enabled,
      usage: false,
    },
    unsupportedReason: enabled ? OPENCODE_ATTACH_LIVE_UNSUPPORTED_REASON : (
      probe.state === 'missing'
        ? 'OpenCode CLI is not installed on the host PATH.'
        : 'OpenCode CLI is present but its version could not be verified locally.'
    ),
  };
}

/** Strict v1 transcript: session/new, prompt with content blocks + stopReason usage, cancel notification. */
export const OPENCODE_OWN_CLI_HAPPY_FIXTURE: OpenCodeFixtureLine[] = [
  {
    direction: 'stdin',
    message: { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp/project' } },
    expectParams: { cwd: '/tmp/project' },
  },
  {
    direction: 'stdout',
    message: {
      jsonrpc: '2.0',
      id: 1,
      result: { sessionId: 'fixture-session-1' },
    },
  },
  {
    direction: 'stdin',
    message: {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: {
        sessionId: 'fixture-session-1',
        prompt: [{ type: 'text', text: 'fixture prompt' }],
        mcpServers: [],
      },
    },
    expectParams: {
      sessionId: 'fixture-session-1',
      prompt: [{ type: 'text', text: 'fixture prompt' }],
      mcpServers: [],
    },
  },
  {
    direction: 'stdout',
    message: {
      jsonrpc: '2.0',
      id: 2,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
      },
    },
  },
  {
    direction: 'stdin',
    message: {
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'fixture-session-1' },
    },
    expectParams: { sessionId: 'fixture-session-1' },
  },
];

export function assertOpenCodeResultShape(message: OpenCodeWireMessage): void {
  if (message.error) throw new Error(`OPENCODE_FIXTURE_ERROR:${message.error.message}`);
  if (!message.result) throw new Error('OPENCODE_FIXTURE_MISSING_RESULT');
}
