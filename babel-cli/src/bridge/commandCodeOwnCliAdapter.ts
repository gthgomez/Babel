import type { HarnessAdapterDescriptor } from './harnessAdapterContract.js';
import {
  COMMAND_CODE_ATTACH_LIVE_UNSUPPORTED_REASON,
  COMMAND_CODE_BASE_CAPABILITIES,
} from './harnessAdapterContract.js';
import type { CommandCodeInstallProbe } from './commandCodeCliDiscovery.js';
import {
  COMMAND_CODE_ACP_PROTOCOL_VERSION,
  type CommandCodeFixtureLine,
  type CommandCodeWireMessage,
  parseCommandCodeLine,
  serializeCommandCodeLine,
} from './commandCodeProtocol.js';

export interface CommandCodeSessionIo {
  write(line: string): void;
  readLine(): Promise<string>;
}

/**
 * Replay a deterministic stdin/stdout transcript for Babel-managed own-CLI sessions.
 * Does not open network sockets or provider credentials.
 */
export async function replayCommandCodeFixture(
  fixture: readonly CommandCodeFixtureLine[],
  io: CommandCodeSessionIo,
): Promise<void> {
  let stdinIndex = 0;
  for (const step of fixture) {
    if (step.direction === 'stdin') {
      const line = await io.readLine();
      const parsed = parseCommandCodeLine(line);
      const expected = step.message;
      if (parsed.method !== expected.method || parsed.id !== expected.id) {
        throw new Error('COMMAND_CODE_FIXTURE_STDIN_MISMATCH');
      }
      stdinIndex += 1;
      continue;
    }
    io.write(serializeCommandCodeLine(step.message));
  }
  const pendingStdin = fixture.filter((line) => line.direction === 'stdin').length;
  if (stdinIndex !== pendingStdin) {
    throw new Error('COMMAND_CODE_FIXTURE_INCOMPLETE');
  }
}

export function buildCommandCodeAdapterDescriptor(
  probe: CommandCodeInstallProbe,
): HarnessAdapterDescriptor {
  const version =
    probe.state === 'verified'
      ? probe.version ?? 'verified'
      : probe.state === 'missing'
        ? 'not-installed'
        : 'unverified';

  const enabled = probe.state === 'verified';
  return {
    id: 'command-code',
    displayName: 'Command Code CLI',
    version,
    capabilities: {
      ...COMMAND_CODE_BASE_CAPABILITIES,
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
    unsupportedReason: enabled ? COMMAND_CODE_ATTACH_LIVE_UNSUPPORTED_REASON : (
      probe.state === 'missing'
        ? 'Command Code CLI is not installed on the host PATH.'
        : 'Command Code CLI is present but its version could not be verified locally.'
    ),
  };
}

/** Minimal happy-path fixture: new session, one prompt, cancel. */
export const COMMAND_CODE_OWN_CLI_HAPPY_FIXTURE: CommandCodeFixtureLine[] = [
  {
    direction: 'stdin',
    message: { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp/project' } },
  },
  {
    direction: 'stdout',
    message: {
      jsonrpc: '2.0',
      id: 1,
      result: { sessionId: 'fixture-session-1', protocol: COMMAND_CODE_ACP_PROTOCOL_VERSION },
    },
  },
  {
    direction: 'stdin',
    message: {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'fixture-session-1', text: 'fixture prompt' },
    },
  },
  {
    direction: 'stdout',
    message: {
      jsonrpc: '2.0',
      id: 2,
      result: { messageId: 'msg-1' },
    },
  },
  {
    direction: 'stdin',
    message: {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/cancel',
      params: { sessionId: 'fixture-session-1' },
    },
  },
  {
    direction: 'stdout',
    message: {
      jsonrpc: '2.0',
      id: 3,
      result: { cancelled: true },
    },
  },
];

export function assertCommandCodeResultShape(message: CommandCodeWireMessage): void {
  if (message.error) throw new Error(`COMMAND_CODE_FIXTURE_ERROR:${message.error.message}`);
  if (!message.result) throw new Error('COMMAND_CODE_FIXTURE_MISSING_RESULT');
}
