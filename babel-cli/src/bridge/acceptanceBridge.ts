/**
 * Test-owned loopback bridge launcher with a deterministic ChatEngine seam.
 * Not reachable from ordinary `babel remote serve`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { assertRemoteListenConfig } from './bindGuard.js';
import {
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from './desktopControllerAuth.js';
import { createDeterministicBridgeEngineFactory } from './deterministicBridgeEngine.js';
import { BridgeServer } from './sessionServer.js';

export const ACCEPTANCE_BRIDGE_ENV = 'BABEL_TEST_ACCEPTANCE_DETERMINISTIC_BRIDGE';
export const ACCEPTANCE_BRIDGE_KIND = 'acceptance-deterministic-bridge-v1';

export function acceptanceBridgeLaunchAllowed(): boolean {
  return process.env[ACCEPTANCE_BRIDGE_ENV] === '1';
}

export function refuseAcceptanceBridgeUnlessAllowed(): void {
  if (!acceptanceBridgeLaunchAllowed()) {
    throw new Error(
      `${ACCEPTANCE_BRIDGE_ENV}=1 is required to launch the acceptance bridge; ordinary production remote serve cannot select a deterministic engine.`,
    );
  }
}

export interface StartAcceptanceBridgeOptions {
  port: number;
  workspace: string;
  allowedOrigins: string[];
  sharedSession: boolean;
  desktopControllerClientId?: string;
  desktopControllerProofKey?: string;
}

export async function startAcceptanceBridge(
  options: StartAcceptanceBridgeOptions,
): Promise<BridgeServer> {
  refuseAcceptanceBridgeUnlessAllowed();
  const server = new BridgeServer({
    port: options.port,
    allowedWorkspaceRoot: options.workspace,
    allowedOrigins: options.allowedOrigins,
    engineFactory: createDeterministicBridgeEngineFactory(),
    acceptanceFixture: { kind: ACCEPTANCE_BRIDGE_KIND, label: 'deterministic acceptance bridge' },
    ...(options.desktopControllerClientId && options.desktopControllerProofKey
      ? {
          desktopControllerClientId: options.desktopControllerClientId,
          desktopControllerProofKey: options.desktopControllerProofKey,
        }
      : {}),
  });
  await server.start(options.port);
  return server;
}

export function printAcceptanceBridgeStartup(input: {
  listenHost: string;
  port: number;
  workspace: string;
  sharedSession: boolean;
  showToken: boolean;
  token: string;
}): void {
  console.log(
    JSON.stringify({
      type: 'acceptance_bridge_startup',
      schemaVersion: 1,
      fixture_kind: ACCEPTANCE_BRIDGE_KIND,
      fixture_execution: true,
    }),
  );
  console.log(`Babel Remote acceptance bridge listening on http://${input.listenHost}:${input.port}`);
  console.log(`workspace: ${input.workspace}`);
  console.log(`health:    http://${input.listenHost}:${input.port}/health`);
  console.log(`rpc:       POST http://${input.listenHost}:${input.port}/rpc`);
  if (input.sharedSession) {
    console.log('shared:    Desktop controller proof on loopback (id header is not a credential)');
  }
  console.log('fixture:   deterministic acceptance bridge — not production provider execution');
  console.log('Auth: Bearer token from ~/.babel/bridge.json');
  if (input.showToken) {
    console.log(`token:     ${input.token}`);
  } else {
    console.log('token:     (not printed; pass --show-token on a TTY to reveal)');
  }
}

/** Health payload extension for acceptance fixture detection (tests only). */
export function acceptanceHealthExtension(
  fixture: { kind: string; label: string } | undefined,
): Record<string, unknown> {
  if (!fixture) return {};
  return {
    acceptance_fixture: {
      kind: fixture.kind,
      label: fixture.label,
      fixture_execution: true,
    },
  };
}
