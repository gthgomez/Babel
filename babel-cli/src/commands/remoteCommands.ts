import { resolve } from 'node:path';

import { Command } from 'commander';

import { assertRemoteListenConfig } from '../bridge/bindGuard.js';
import { BridgeServer } from '../bridge/sessionServer.js';

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
    .action(async (options: { port?: string; project?: string; origin?: string[] }) => {
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
          'http://127.0.0.1',
          'http://localhost',
          'https://localhost',
          ...extraOrigins,
        ],
      });
      await server.start(port);
      console.log(`Babel Remote listening on http://${listenHost}:${server.port}`);
      console.log(`workspace: ${workspace}`);
      console.log(`health:    http://${listenHost}:${server.port}/health`);
      console.log(`ui:        http://${listenHost}:${server.port}/ui`);
      console.log(`rpc:       POST http://${listenHost}:${server.port}/rpc`);
      console.log('Auth: Bearer token from ~/.babel/bridge.json (printed only to this TTY).');
      console.log(`token:     ${server.token}`);
      console.log('');
      console.log('Reachability: expose loopback via Tailscale Serve, not Funnel:');
      console.log(`  tailscale serve --bg ${server.port}`);
      console.log('Do not run: tailscale funnel');
      console.log('Ctrl+C to stop. Closing this process stops the gateway; ChatEngine turns are cancelled.');
    });
}
