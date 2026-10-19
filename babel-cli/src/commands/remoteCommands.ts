import { resolve } from 'node:path';

import { Command } from 'commander';

import { assertRemoteListenConfig } from '../bridge/bindGuard.js';
import {
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from '../bridge/desktopControllerAuth.js';
import { BridgeServer } from '../bridge/sessionServer.js';
import {
  REMOTE_UI_FIXTURE_SCENARIOS,
  startRemoteUiFixtureServer,
} from '../bridge/remoteUiFixture.js';
import { executeSharedProtocolHostRun } from '../bridge/sharedProtocolHostRun.js';

export function registerRemoteCommands(program: Command): void {
  const remote = program
    .command('remote')
    .description('Loopback remote-control surface for ChatEngine (ADR-010 over HTTP/WS)');

  remote
    .command('serve')
    .description('Start the authenticated 127.0.0.1 bridge and ADR-010 JSON-RPC gateway')
    .option('--port <n>', 'Listen port', process.env['BABEL_BRIDGE_PORT'] ?? '4545')
    .option('--project <dir>', 'Registered workspace root (authorization handle, not a sandbox)')
    .option(
      '--origin <url>',
      'Allowed browser Origin (repeat for Tailscale Serve HTTPS hostname). Loopback HTTP origins are always allowed.',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--show-token', 'Print the bearer token (TTY only)')
    .option(
      '--shared-session',
      'Enable loopback Desktop controller identity for CLI/Desktop/PWA single-owner sessions',
    )
    .action(async (options: {
      port?: string;
      project?: string;
      origin?: string[];
      showToken?: boolean;
      sharedSession?: boolean;
    }) => {
      const listenHost = assertRemoteListenConfig();
      const workspace = resolve(options.project ?? process.cwd());
      const port = Number(options.port ?? 4545);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        console.error('Invalid --port');
        process.exitCode = 1;
        return;
      }
      const extraOrigins = (options.origin ?? []).filter((origin) => origin && origin !== '*');
      const sharedSession =
        options.sharedSession === true ||
        process.env['BABEL_BRIDGE_SHARED_SESSION'] === '1';
      const desktopControllerClientId = sharedSession
        ? (process.env['BABEL_BRIDGE_DESKTOP_CLIENT_ID']?.trim() ||
            mintDesktopControllerClientId())
        : undefined;
      const desktopControllerProofKey = sharedSession
        ? (process.env['BABEL_BRIDGE_DESKTOP_PROOF_KEY']?.trim() ||
            mintDesktopControllerProofKey())
        : undefined;
      if (sharedSession && desktopControllerClientId && desktopControllerProofKey) {
        process.env['BABEL_BRIDGE_DESKTOP_CLIENT_ID'] = desktopControllerClientId;
        process.env['BABEL_BRIDGE_DESKTOP_PROOF_KEY'] = desktopControllerProofKey;
        process.env['BABEL_BRIDGE_SHARED_SESSION'] = '1';
      }
      const server = new BridgeServer({
        port,
        allowedWorkspaceRoot: workspace,
        allowedOrigins: [
          'http://127.0.0.1:*',
          'http://localhost:*',
          'https://localhost:*',
          ...extraOrigins,
        ],
        ...(desktopControllerClientId && desktopControllerProofKey
          ? { desktopControllerClientId, desktopControllerProofKey }
          : {}),
      });
      await server.start(port);
      console.log(`Babel Remote listening on http://${listenHost}:${server.port}`);
      console.log(`workspace: ${workspace}`);
      console.log(`health:    http://${listenHost}:${server.port}/health`);
      console.log(`ui:        http://${listenHost}:${server.port}/ui`);
      console.log(`rpc:       POST http://${listenHost}:${server.port}/rpc`);
      if (sharedSession) {
        console.log('shared:    Desktop controller proof on loopback (id header is not a credential)');
      }
      console.log('Auth: Bearer token from ~/.babel/bridge.json');
      if (options.showToken && Boolean(process.stdout.isTTY)) {
        console.log(`token:     ${server.token}`);
      } else {
        console.log('token:     (not printed; pass --show-token on a TTY to reveal)');
      }
      console.log('');
      console.log('Reachability: expose loopback via Tailscale Serve, not Funnel:');
      console.log(`  tailscale serve --bg ${server.port}`);
      console.log('Do not run: tailscale funnel');
      console.log('Ctrl+C to stop. Closing this process stops the gateway; ChatEngine turns are cancelled.');
    });

  remote
    .command('host-run')
    .description('Run one chat turn on the loopback shared protocol host (Desktop IPC entry)')
    .requiredOption('--project-root <dir>', 'Registered workspace root')
    .requiredOption('--run-id <id>', 'Desktop run id')
    .option('--resume-thread <id>', 'Resume an existing protocol thread id')
    .option('--model <id>', 'Provider model id for thread.create')
    .option('--provider <id>', 'Provider id for thread.create')
    .option('--output-format <fmt>', 'Output format', 'stream-json')
    .allowExcessArguments(true)
    .action(async (options: {
      projectRoot: string;
      runId: string;
      resumeThread?: string;
      model?: string;
      provider?: string;
      outputFormat?: string;
    }, command) => {
      const port = Number(process.env['BABEL_BRIDGE_PORT'] ?? '4545');
      const clientId = process.env['BABEL_BRIDGE_DESKTOP_CLIENT_ID']?.trim() ?? '';
      const proofKey = process.env['BABEL_BRIDGE_DESKTOP_PROOF_KEY']?.trim() ?? '';
      const taskParts = (command.args as string[]) ?? [];
      const task = taskParts.join(' ').trim();
      if (!task) {
        console.error('Task text is required after --');
        process.exitCode = 1;
        return;
      }
      if (!clientId || !proofKey) {
        console.error('Missing BABEL_BRIDGE_DESKTOP_CLIENT_ID or BABEL_BRIDGE_DESKTOP_PROOF_KEY');
        process.exitCode = 1;
        return;
      }
      const write = (event: Record<string, unknown>) => {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      };
      const code = await executeSharedProtocolHostRun(
        {
          port,
          projectRoot: resolve(options.projectRoot),
          task,
          runId: options.runId,
          desktopClientId: clientId,
          desktopProofKey: proofKey,
          stdin: process.stdin,
          commandId: `desktop-${options.runId}`,
          ...(options.resumeThread ? { resumeThreadId: options.resumeThread } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.provider ? { provider: options.provider } : {}),
        },
        write,
      );
      process.exit(code);
    });

  remote
    .command('ui-benchmark')
    .description('Start the loopback-only deterministic Remote UI fixture server (no auth, providers, or mutations)')
    .option('--port <n>', 'Fixture port (0 chooses a free port)', '0')
    .option('--scenario <id>', 'Scenario to print as the starting URL', 'connected-idle')
    .action(async (options: { port?: string; scenario?: string }) => {
      const port = Number(options.port ?? 0);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error('Invalid --port');
        process.exitCode = 1;
        return;
      }
      const scenario = options.scenario ?? 'connected-idle';
      if (!REMOTE_UI_FIXTURE_SCENARIOS.some((candidate) => candidate.id === scenario)) {
        console.error(`Unknown --scenario: ${scenario}`);
        process.exitCode = 1;
        return;
      }
      const fixture = await startRemoteUiFixtureServer({ port });
      console.log(`Babel Remote UI fixture listening on ${fixture.url}`);
      console.log(`scenario:  ${fixture.url}?scenario=${encodeURIComponent(scenario)}`);
      console.log(`scenarios: ${REMOTE_UI_FIXTURE_SCENARIOS.map((candidate) => candidate.id).join(', ')}`);
      console.log('Mode: deterministic, read-only, loopback-only; no provider or workspace access.');
      console.log('Ctrl+C to stop.');
    });
}
