import { resolve } from 'node:path';

import { Command } from 'commander';

import { assertRemoteListenConfig } from '../bridge/bindGuard.js';
import { BridgeServer } from '../bridge/sessionServer.js';
import {
  REMOTE_UI_FIXTURE_SCENARIOS,
  startRemoteUiFixtureServer,
} from '../bridge/remoteUiFixture.js';

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
    .action(async (options: { port?: string; project?: string; origin?: string[]; showToken?: boolean }) => {
      const listenHost = assertRemoteListenConfig();
      const workspace = resolve(options.project ?? process.cwd());
      const port = Number(options.port ?? 4545);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        console.error('Invalid --port');
        process.exit(1);
      }
      const extraOrigins = (options.origin ?? []).filter((origin) => origin && origin !== '*');
      const server = new BridgeServer({
        port,
        allowedWorkspaceRoot: workspace,
        allowedOrigins: [
          'http://127.0.0.1:*',
          'http://localhost:*',
          'https://localhost:*',
          ...extraOrigins,
        ],
      });
      await server.start(port);
      console.log(`Babel Remote listening on http://${listenHost}:${server.port}`);
      console.log(`workspace: ${workspace}`);
      console.log(`health:    http://${listenHost}:${server.port}/health`);
      console.log(`ui:        http://${listenHost}:${server.port}/ui`);
      console.log(`rpc:       POST http://${listenHost}:${server.port}/rpc`);
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
    .command('ui-benchmark')
    .description('Start the loopback-only deterministic Remote UI fixture server (no auth, providers, or mutations)')
    .option('--port <n>', 'Fixture port (0 chooses a free port)', '0')
    .option('--scenario <id>', 'Scenario to print as the starting URL', 'connected-idle')
    .action(async (options: { port?: string; scenario?: string }) => {
      const port = Number(options.port ?? 0);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error('Invalid --port');
        process.exit(1);
      }
      const scenario = options.scenario ?? 'connected-idle';
      if (!REMOTE_UI_FIXTURE_SCENARIOS.some((candidate) => candidate.id === scenario)) {
        console.error(`Unknown --scenario: ${scenario}`);
        process.exit(1);
      }
      const fixture = await startRemoteUiFixtureServer({ port });
      console.log(`Babel Remote UI fixture listening on ${fixture.url}`);
      console.log(`scenario:  ${fixture.url}?scenario=${encodeURIComponent(scenario)}`);
      console.log(`scenarios: ${REMOTE_UI_FIXTURE_SCENARIOS.map((candidate) => candidate.id).join(', ')}`);
      console.log('Mode: deterministic, read-only, loopback-only; no provider or workspace access.');
      console.log('Ctrl+C to stop.');
    });
}
