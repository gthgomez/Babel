/**
 * HTTP + WebSocket server for the Babel IDE Bridge.
 *
 * Serves as the remote control endpoint for IDEs, external tools, and
 * remote clients. Uses only Node.js built-in modules (`node:http`) —
 * no Express or third-party HTTP libraries.
 *
 * Endpoints:
 *   GET    /health            — unauthenticated liveness (no secrets)
 *   GET    /ui                — spike PWA (no secrets; token entered in UI)
 *   POST   /rpc               — ADR-010 JSON-RPC (authenticated)
 *   POST   /sessions          — Create a transport session
 *   GET    /sessions          — List active sessions
 *   GET    /sessions/:id      — Get session status
 *   DELETE /sessions/:id      — Stop and remove a session
 *   WS     /ws?sessionId=...  — ADR-010 JSON-RPC over WebSocket
 *
 * Authentication: Bearer token via `Authorization` header for HTTP.
 * V1 WebSocket requires a short-lived single-use ticket from POST /ws/ticket.
 * Long-lived bearer / `?token=` upgrades are rejected unless
 * BABEL_REMOTE_ALLOW_LEGACY_WS_BEARER=1 (header only; no thread events).
 *
 * Configuration:
 *   - Port:    BABEL_BRIDGE_PORT env var, or bridge.json port, or 4545
 *   - Token:   bridge.json authToken (auto-generated on first start)
 *   - Origins: bridge.json allowedOrigins (defaults to ['http://localhost:*'])
 */

import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type {
  BridgeSession,
  BridgeTransport,
} from './types.js';
import {
  verifyToken,
  extractBearerToken,
  extractQueryToken,
  loadBridgeConfig,
  persistBridgeConfig,
  DEFAULT_BRIDGE_PORT,
} from './auth.js';
import { computeWsAcceptKey, createTransport, WebSocketTransport } from './transport.js';
import { sessionRunner } from './sessionRunner.js';
import { assertLoopbackBind } from './bindGuard.js';
import {
  ProtocolGateway,
  REMOTE_MUTATING_RPC_METHODS,
  originAllowed,
  readLimitedBody,
} from './protocolGateway.js';
import { writeRemoteUiResponse } from './remoteUiAssets.js';
import { WsTicketStore } from './wsTicket.js';
import type { ProtocolHostState } from '../protocol/client/host.js';
import { closeProtocolHostState, parseProtocolRequest } from '../protocol/client/host.js';
import { DevicePairingService, REMOTE_PAIRING_COOKIE } from './devicePairing.js';
import { authorizeThreadScopedWsRpc } from './wsRpcAuthorization.js';
import {
  bridgeClientPrincipalMatches,
  isBridgeClientAuthenticated,
  isBridgeHostAdminAuthenticated,
  isBridgeRequestAuthenticated,
  resolveBridgeClientContext,
} from './bridgeClientAuth.js';
import { writePairUiResponse } from './pairUiAssets.js';
import { pairedDeviceMutationOriginOk } from './bridgeMutationPolicy.js';
import type { BridgeClientContext } from './bridgeClientAuth.js';
import { acceptanceHealthExtension } from './acceptanceBridge.js';
import { createHarnessAwareEngineFactory } from './harnessEngineFactory.js';
// ─── Types ─────────────────────────────────────────────────────────────────────

export interface BridgeServerOptions {
  /** Listen port. Default: 4545 (or BABEL_BRIDGE_PORT env, or bridge.json). */
  port?: number;
  /** Auth token. Auto-generated if not provided. */
  authToken?: string;
  /** Allowed origins for CORS. */
  allowedOrigins?: string[];
  /** Registered workspace root for ADR-010 thread.create. */
  allowedWorkspaceRoot?: string;
  /** Injected protocol gateway (tests). */
  protocolGateway?: ProtocolGateway;
  /** Optional ChatEngine factory for ADR-010 (tests / remote serve). */
  engineFactory?: ProtocolHostState['engineFactory'];
  /**
   * Accept a long-lived bearer header on `/ws` without a ticket.
   * Default off. Env override: BABEL_REMOTE_ALLOW_LEGACY_WS_BEARER=1.
   * Query `?token=` is never accepted. Legacy sockets do not receive
   * thread-scoped turn.event fan-out.
   */
  allowLegacyWsBearer?: boolean;
  /** Register a callback for server lifecycle events. */
  onListening?: (port: number) => void;
  onError?: (error: Error) => void;
  onSessionCreated?: (session: BridgeSession) => void;
  /** Injected pairing service (tests). */
  devicePairing?: DevicePairingService;
  /**
   * Enforce per-thread control leases for remote mutations (default true).
   * Set false only in isolated unit tests — never in `babel remote serve`.
   */
  enforceControlLease?: boolean;
  /**
   * Narrow HTTP principal barriers for regression tests (never set in production serve).
   */
  httpPrincipalTestHooks?: BridgeHttpPrincipalTestHooks;
  /**
   * When set, loopback requests carrying `x-babel-desktop-client-id` authenticate as
   * the Desktop controller without a host bearer (shared protocol-host ownership).
   */
  desktopControllerClientId?: string;
  /** Per-launch desktop controller proof secret (never published to remote UIs). */
  desktopControllerProofKey?: string;
  /** Test-only acceptance fixture metadata (never set on ordinary `remote serve`). */
  acceptanceFixture?: { kind: string; label: string };
}

/** Test-only hooks for post-initial-auth / pre-body-read synchronization. */
export interface BridgeHttpPrincipalTestHooks {
  afterInitialPrincipalAuthenticated?: (scope: 'mint' | 'rpc') => void | Promise<void>;
}

interface ParsedUrl {
  pathname: string;
  searchParams: URLSearchParams;
}

// ─── URL parsing helpers ───────────────────────────────────────────────────────

function parseRequestUrl(req: IncomingMessage): ParsedUrl | null {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    return { pathname: url.pathname, searchParams: url.searchParams };
  } catch {
    return null;
  }
}

/** Match a pathname like /sessions/:id and extract the ID segment. */
function matchSessionPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  // /sessions/<id>
  if (parts.length === 2 && parts[0] === 'sessions') {
    return parts[1] ?? null;
  }
  return null;
}

// ─── Authentication ────────────────────────────────────────────────────────────

function validateAuthenticatedClient(
  client: BridgeClientContext,
  pairing: DevicePairingService,
): { ok: true } | { ok: false; status: number; message: string } {
  if (!isBridgeClientAuthenticated(client)) {
    return { ok: false, status: 401, message: 'Authentication required' };
  }
  if (client.deviceId && !pairing.isDeviceAuthorized(client.deviceId)) {
    return { ok: false, status: 403, message: 'Device authorization revoked' };
  }
  return { ok: true };
}

// ─── CORS helpers ──────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function setCorsHeaders(
  res: ServerResponse,
  origin: string | undefined,
  allowedOrigins: string[],
): void {
  if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    // Check if origin is allowed
    const allowed = originAllowed(origin, allowedOrigins);
    res.setHeader(
      'Access-Control-Allow-Origin',
      allowed ? origin : 'null',
    );
  }

  // Always set CORS methods/headers/max-age regardless of origin
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
}

// ─── JSON response helpers ────────────────────────────────────────────────────

function jsonResponse(
  res: ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function errorResponse(
  res: ServerResponse,
  statusCode: number,
  message: string,
): void {
  jsonResponse(res, statusCode, { error: message });
}

// ─── BridgeServer ──────────────────────────────────────────────────────────────

/**
 * The Babel IDE Bridge server.
 *
 * Manages HTTP endpoints, WebSocket upgrades, session lifecycle, and
 * message routing between remote clients and session runners.
 */
export class BridgeServer {
  private server: Server;
  private options: BridgeServerOptions;
  private authToken: string;
  private allowedOrigins: string[];
  private _started = false;
  private _port = DEFAULT_BRIDGE_PORT;
  readonly protocolGateway: ProtocolGateway;
  private readonly listenHost = '127.0.0.1';
  /**
   * Per-launch instance label supplied by the owning host (Desktop). Echoed on
   * /health so a host can prove the responder is the child it started rather
   * than any other loopback server on the same port. It is not a credential
   * and grants no authority.
   */
  private readonly bridgeInstance = (process.env['BABEL_BRIDGE_INSTANCE'] ?? '').trim();
  readonly wsTickets = new WsTicketStore();
  readonly devicePairing: DevicePairingService;

  /** Active WebSocket transports keyed by session ID. */
  private wsTransports = new Map<string, BridgeTransport>();

  /** Live sockets for immediate revocation of paired devices. */
  private readonly deviceSocketClosers = new Map<string, Set<() => void>>();

  /** Generation counter per session — prevents stale transport onClose from destroying the active router. */
  private transportGenerations = new Map<string, number>();

  constructor(options?: BridgeServerOptions) {
    this.options = options ?? {};

    // Load config from file, with env/option overrides
    const config = loadBridgeConfig();
    this.authToken =
      this.options.authToken ?? config.authToken ?? randomUUID();
    this.allowedOrigins =
      this.options.allowedOrigins ??
      config.allowedOrigins ?? [
        'http://127.0.0.1:*',
        'http://localhost:*',
        'https://localhost:*',
      ];
    const enforceControlLease = this.options.enforceControlLease !== false;
    this.protocolGateway =
      this.options.protocolGateway ??
      new ProtocolGateway({
        allowedWorkspaceRoot: this.options.allowedWorkspaceRoot ?? process.cwd(),
        enforceControlLease,
        engineFactory:
          this.options.engineFactory ?? createHarnessAwareEngineFactory(),
      });
    this.devicePairing =
      this.options.devicePairing ?? new DevicePairingService(this.authToken);

    this.server = createServer((req, res) => this.handleRequest(req, res));

    // Handle WebSocket upgrades
    this.server.on('upgrade', (req, socket, head) =>
      this.handleWebSocketUpgrade(req, socket as import('node:net').Socket, head),
    );
  }

  private desktopControllerClientId(): string | undefined {
    const fromOptions = this.options.desktopControllerClientId?.trim();
    if (fromOptions) return fromOptions;
    const fromEnv = process.env['BABEL_BRIDGE_DESKTOP_CLIENT_ID']?.trim();
    return fromEnv || undefined;
  }

  private desktopControllerProofKey(): string | undefined {
    const fromOptions = this.options.desktopControllerProofKey?.trim();
    if (fromOptions) return fromOptions;
    const fromEnv = process.env['BABEL_BRIDGE_DESKTOP_PROOF_KEY']?.trim();
    return fromEnv || undefined;
  }

  private resolveHttpClient(
    req: IncomingMessage,
    parsedUrl?: ParsedUrl | null,
  ): BridgeClientContext {
    return resolveBridgeClientContext(
      req,
      this.authToken,
      parsedUrl,
      this.devicePairing,
      this.desktopControllerClientId(),
      this.desktopControllerProofKey(),
    );
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start the server. Reads port from env `BABEL_BRIDGE_PORT`, then options,
   * then config file, defaulting to 4545.
   *
   * @returns A promise that resolves when the server is listening.
   */
  async start(port?: number): Promise<void> {
    if (this._started) return;
    this._started = true;

    // Port resolution: arg > env > options > config > default
    const resolvedPort =
      port ??
      (process.env['BABEL_BRIDGE_PORT']
        ? Number(process.env['BABEL_BRIDGE_PORT'])
        : undefined) ??
      this.options.port ??
      DEFAULT_BRIDGE_PORT;

    this._port = resolvedPort;
    assertLoopbackBind(this.listenHost);

    return new Promise<void>((resolve, reject) => {
      this.server.on('listening', () => {
        const bound = this.server.address();
        if (bound && typeof bound === 'object' && bound.port > 0) {
          this._port = bound.port;
        }
        // Persist config with the actual auth token
        const config = loadBridgeConfig();
        if (!config.authToken || config.authToken !== this.authToken) {
          persistBridgeConfig({
            ...config,
            authToken: this.authToken,
            port: this._port,
          });
        }
        this.options.onListening?.(this._port);
        resolve();
      });

      this.server.on('error', (err: Error) => {
        this.options.onError?.(err);
        reject(err);
      });

      this.server.listen(resolvedPort, this.listenHost);
    });
  }

  /**
   * Stop the server and clean up all sessions.
   */
  async stop(): Promise<void> {
    if (!this._started) return;

    // Close all WebSocket transports
    for (const transport of this.wsTransports.values()) {
      transport.close();
    }
    this.wsTransports.clear();
    this.transportGenerations.clear();

    // Shutdown session runner
    sessionRunner.shutdown();

    // P05/P11 (A4): release the gateway host's durable admission handles so a
    // stopped bridge leaks no SQLite ownership into a later start.
    closeProtocolHostState(this.protocolGateway.host);

    if (typeof this.server.closeAllConnections === 'function') {
      this.server.closeAllConnections();
    }

    return new Promise<void>((resolve) => {
      this.server.close(() => {
        this._started = false;
        resolve();
      });
    });
  }

  /** Whether the server is started. */
  get started(): boolean {
    return this._started;
  }

  /** The actual port the server is listening on. */
  get port(): number {
    return this._port;
  }

  /** The configured auth token. */
  get token(): string {
    return this.authToken;
  }

  // ── HTTP request handling ─────────────────────────────────────────────────

  private handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const parsedUrl = parseRequestUrl(req);
    if (!parsedUrl) {
      errorResponse(res, 400, 'Invalid request URL');
      return;
    }

    const { pathname } = parsedUrl;

    if (pathname === '/health' && req.method === 'GET') {
      const sharedSession = Boolean(this.desktopControllerClientId());
      jsonResponse(res, 200, {
        ok: true,
        bind: `${this.listenHost}:${this._port}`,
        protocol: 'adr-010',
        ...(sharedSession ? { shared_session: true } : {}),
        ...(this.bridgeInstance ? { instance: this.bridgeInstance } : {}),
        ...acceptanceHealthExtension(this.options.acceptanceFixture),
      });
      return;
    }

    if ((pathname === '/ui' || pathname.startsWith('/ui/')) && req.method === 'GET') {
      if (writeRemoteUiResponse(pathname, res)) return;
      errorResponse(res, 404, 'Not found');
      return;
    }

    if ((pathname === '/pair' || pathname === '/pair/') && req.method === 'GET') {
      if (writePairUiResponse(res)) return;
      errorResponse(res, 404, 'Not found');
      return;
    }

    if (pathname === '/auth/session' && req.method === 'GET') {
      setCorsHeaders(res, req.headers['origin'], this.allowedOrigins);
      const client = this.resolveHttpClient(req, parsedUrl);
      if (client.authKind === 'paired_device' && client.deviceId) {
        jsonResponse(res, 200, {
          ok: true,
          auth: 'paired_device',
          deviceId: client.deviceId,
        });
        return;
      }
      if (client.authKind === 'host_bearer' || client.authKind === 'query_bearer') {
        jsonResponse(res, 200, { ok: true, auth: 'host' });
        return;
      }
      if (client.authKind === 'desktop_controller') {
        jsonResponse(res, 200, { ok: true, auth: 'desktop_controller', clientId: client.clientId });
        return;
      }
      jsonResponse(res, 200, { ok: false, auth: 'none' });
      return;
    }

    if (pathname.startsWith('/pair')) {
      void this.handlePairingRoute(req, res, parsedUrl);
      return;
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res, req.headers['origin'], this.allowedOrigins);
      res.writeHead(204);
      res.end();
      return;
    }

    // Authenticate all non-OPTIONS requests
    if (
      !isBridgeRequestAuthenticated(
        req,
        this.authToken,
        parsedUrl,
        this.devicePairing,
        this.desktopControllerClientId(),
        this.desktopControllerProofKey(),
      )
    ) {
      setCorsHeaders(res, req.headers['origin'], this.allowedOrigins);
      errorResponse(res, 401, 'Unauthorized — provide a valid Bearer token');
      return;
    }

    const mutationClient = this.resolveHttpClient(req, parsedUrl);
    if (
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      !pairedDeviceMutationOriginOk(req, mutationClient, this.allowedOrigins)
    ) {
      setCorsHeaders(res, req.headers['origin'], this.allowedOrigins);
      errorResponse(res, 403, 'Origin not allowed for paired-device mutation');
      return;
    }

    setCorsHeaders(res, req.headers['origin'], this.allowedOrigins);

    if (pathname === '/ws/ticket') {
      if (req.method !== 'POST') {
        errorResponse(res, 405, 'Method not allowed');
        return;
      }
      void this.handleMintTicket(req, res);
      return;
    }

    if (pathname === '/rpc') {
      if (req.method !== 'POST') {
        errorResponse(res, 405, 'Method not allowed');
        return;
      }
      const origin = req.headers['origin'];
      if (!originAllowed(origin, this.allowedOrigins, req.socket.remoteAddress)) {
        errorResponse(res, 403, 'Origin not allowed');
        return;
      }
      void this.handleRpc(req, res);
      return;
    }

    // Route requests
    switch (pathname) {
      case '/sessions':
        if (req.method === 'POST') {
          this.handleCreateSession(req, res);
        } else if (req.method === 'GET') {
          this.handleListSessions(req, res);
        } else {
          errorResponse(res, 405, 'Method not allowed');
        }
        break;

      default: {
        // /sessions/:id
        const sessionId = matchSessionPath(pathname);
        if (sessionId) {
          if (req.method === 'GET') {
            this.handleGetSession(res, sessionId);
          } else if (req.method === 'DELETE') {
            this.handleDeleteSession(res, sessionId);
          } else {
            errorResponse(res, 405, 'Method not allowed');
          }
        } else {
          errorResponse(res, 404, 'Not found');
        }
        break;
      }
    }
  }

  // ── Pairing endpoints ─────────────────────────────────────────────────────

  private async handlePairingRoute(
    req: IncomingMessage,
    res: ServerResponse,
    parsedUrl: ParsedUrl,
  ): Promise<void> {
    const { pathname } = parsedUrl;
    setCorsHeaders(res, req.headers['origin'], this.allowedOrigins);
    const origin = req.headers['origin'];
    const originOk = originAllowed(origin, this.allowedOrigins, req.socket.remoteAddress);

    if (pathname === '/pair/request' && req.method === 'POST') {
      if (!originOk) {
        errorResponse(res, 403, 'Origin not allowed');
        return;
      }
      const body = await readLimitedBody(req, 16 * 1024);
      if (!body.ok) {
        errorResponse(res, 413, body.error);
        return;
      }
      let parsed: { challenge_id?: unknown; device_label?: unknown };
      try {
        parsed = JSON.parse(body.body) as { challenge_id?: unknown; device_label?: unknown };
      } catch {
        errorResponse(res, 400, 'Invalid JSON');
        return;
      }
      if (typeof parsed.challenge_id !== 'string' || typeof parsed.device_label !== 'string') {
        errorResponse(res, 400, 'challenge_id and device_label are required');
        return;
      }
      const result = this.devicePairing.requestPairing(parsed.challenge_id, parsed.device_label);
      if (!result.ok) {
        errorResponse(res, 400, result.error);
        return;
      }
      jsonResponse(res, 200, { ok: true, state: 'awaiting_approval' });
      return;
    }

    if (pathname === '/pair/status' && req.method === 'GET') {
      const challengeId = parsedUrl.searchParams.get('challenge_id');
      if (!challengeId) {
        errorResponse(res, 400, 'challenge_id is required');
        return;
      }
      const status = this.devicePairing.challengeStatus(challengeId);
      if (status.state === 'approved') {
        const exchanged = this.devicePairing.exchangeChallenge(challengeId);
        if (!exchanged.ok) {
          errorResponse(res, 400, exchanged.error);
          return;
        }
        const secure = (req.headers['x-forwarded-proto'] ?? '').includes('https');
        const cookieFlags = secure
          ? 'HttpOnly; Secure; SameSite=Strict; Path=/'
          : 'HttpOnly; SameSite=Lax; Path=/';
        res.setHeader(
          'Set-Cookie',
          `${REMOTE_PAIRING_COOKIE}=${encodeURIComponent(exchanged.session.sessionToken)}; ${cookieFlags}`,
        );
        jsonResponse(res, 200, { ok: true, state: 'paired' });
        return;
      }
      jsonResponse(res, 200, { ok: true, state: status.state, deviceLabel: status.deviceLabel });
      return;
    }

    if (!isBridgeHostAdminAuthenticated(req, this.authToken, parsedUrl)) {
      errorResponse(res, 401, 'Host administrator authentication required');
      return;
    }

    if (pathname === '/pair/challenge' && req.method === 'POST') {
      const challenge = this.devicePairing.createChallenge();
      jsonResponse(res, 201, {
        challengeId: challenge.challengeId,
        expiresAt: new Date(challenge.expiresAtMs).toISOString(),
        pairPath: `/pair?challenge_id=${encodeURIComponent(challenge.challengeId)}`,
      });
      return;
    }

    if (pathname === '/pair/approve' && req.method === 'POST') {
      const body = await readLimitedBody(req, 16 * 1024);
      if (!body.ok) {
        errorResponse(res, 413, body.error);
        return;
      }
      let parsed: { challenge_id?: unknown };
      try {
        parsed = JSON.parse(body.body) as { challenge_id?: unknown };
      } catch {
        errorResponse(res, 400, 'Invalid JSON');
        return;
      }
      if (typeof parsed.challenge_id !== 'string') {
        errorResponse(res, 400, 'challenge_id is required');
        return;
      }
      const approved = this.devicePairing.approveChallenge(parsed.challenge_id);
      if (!approved.ok) {
        errorResponse(res, 400, approved.error);
        return;
      }
      jsonResponse(res, 200, { ok: true, device: approved.device });
      return;
    }

    if (pathname === '/pair/devices' && req.method === 'GET') {
      jsonResponse(res, 200, { devices: this.devicePairing.listDevices() });
      return;
    }

    const deviceId = pathname.startsWith('/pair/devices/')
      ? pathname.slice('/pair/devices/'.length)
      : null;
    if (deviceId && req.method === 'DELETE') {
      const revoked = this.devicePairing.revokeDevice(deviceId);
      if (!revoked) {
        errorResponse(res, 404, 'Device not found');
        return;
      }
      this.protocolGateway.controlLeases.fenceDevice(`device:${deviceId}`);
      this.wsTickets.revokeForDevice(deviceId);
      this.closeDeviceSockets(deviceId);
      jsonResponse(res, 200, { ok: true, deviceId });
      return;
    }

    errorResponse(res, 404, 'Not found');
  }

  // ── Session endpoints ─────────────────────────────────────────────────────

  private async handleMintTicket(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsedUrl = parseRequestUrl(req);
    const principalBefore = this.resolveHttpClient(req, parsedUrl);
    const authBefore = validateAuthenticatedClient(principalBefore, this.devicePairing);
    if (!authBefore.ok) {
      errorResponse(res, authBefore.status, authBefore.message);
      return;
    }
    const bodyPromise = readLimitedBody(req, 64 * 1024);
    await this.options.httpPrincipalTestHooks?.afterInitialPrincipalAuthenticated?.('mint');
    const body = await bodyPromise;
    if (!body.ok) {
      errorResponse(res, 413, body.error);
      return;
    }
    let parsed: { session_id?: unknown; thread_id?: unknown };
    try {
      parsed = JSON.parse(body.body) as { session_id?: unknown; thread_id?: unknown };
    } catch {
      errorResponse(res, 400, 'Invalid JSON');
      return;
    }
    if (typeof parsed.session_id !== 'string' || typeof parsed.thread_id !== 'string') {
      errorResponse(res, 400, 'session_id and thread_id are required');
      return;
    }
    if (!sessionRunner.getSession(parsed.session_id)) {
      errorResponse(res, 404, `Session '${parsed.session_id}' not found`);
      return;
    }
    const owned = this.protocolGateway.authorizeTicketMint({
      sessionId: parsed.session_id,
      threadId: parsed.thread_id,
    });
    if (!owned.ok) {
      const status = owned.error === 'unknown_thread' ? 404 : 403;
      errorResponse(res, status, `ticket mint denied: ${owned.error}`);
      return;
    }
    const principalAfter = this.resolvePrincipalAfterBody(
      req,
      parsedUrl,
      principalBefore,
      'mint',
      res,
    );
    if (!principalAfter) return;
    const minted = this.wsTickets.mint({
      sessionId: parsed.session_id,
      threadId: parsed.thread_id,
      clientId: principalAfter.clientId,
      authKind: principalAfter.authKind,
      ...(principalAfter.deviceId !== undefined ? { deviceId: principalAfter.deviceId } : {}),
    });
    jsonResponse(res, 200, minted);
  }

  private registerDeviceSocket(deviceId: string, closer: () => void): void {
    let set = this.deviceSocketClosers.get(deviceId);
    if (!set) {
      set = new Set();
      this.deviceSocketClosers.set(deviceId, set);
    }
    set.add(closer);
  }

  private unregisterDeviceSocket(deviceId: string, closer: () => void): void {
    const set = this.deviceSocketClosers.get(deviceId);
    if (!set) return;
    set.delete(closer);
    if (set.size === 0) this.deviceSocketClosers.delete(deviceId);
  }

  private closeDeviceSockets(deviceId: string): void {
    const set = this.deviceSocketClosers.get(deviceId);
    if (!set) return;
    for (const closer of set) closer();
    this.deviceSocketClosers.delete(deviceId);
  }

  /** Test-only: count registered socket closers for a paired device. */
  testDeviceSocketCloserCount(deviceId: string): number {
    return this.deviceSocketClosers.get(deviceId)?.size ?? 0;
  }

  /** @internal Extension point for gateway tests that simulate pre-fix principal races. */
  protected resolvePrincipalAfterBody(
    req: IncomingMessage,
    parsedUrl: ParsedUrl | null,
    principalBefore: BridgeClientContext,
    scope: 'mint' | 'rpc',
    res: ServerResponse,
  ): BridgeClientContext | null {
    const principalAfter = this.resolveHttpClient(req, parsedUrl);
    if (!bridgeClientPrincipalMatches(principalBefore, principalAfter)) {
      if (scope === 'mint') {
        errorResponse(res, 401, 'Authentication expired or changed during request');
      } else {
        jsonResponse(res, 401, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32001, message: 'Authentication expired or changed during request' },
        });
      }
      return null;
    }
    const authAfter = validateAuthenticatedClient(principalAfter, this.devicePairing);
    if (!authAfter.ok) {
      if (scope === 'mint') {
        errorResponse(res, authAfter.status, authAfter.message);
      } else {
        jsonResponse(res, authAfter.status, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32001, message: authAfter.message },
        });
      }
      return null;
    }
    return principalAfter;
  }

  private async handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsedUrl = parseRequestUrl(req);
    const principalBefore = this.resolveHttpClient(req, parsedUrl);
    const authBefore = validateAuthenticatedClient(principalBefore, this.devicePairing);
    if (!authBefore.ok) {
      jsonResponse(res, authBefore.status, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: authBefore.message },
      });
      return;
    }
    const bodyPromise = readLimitedBody(req);
    await this.options.httpPrincipalTestHooks?.afterInitialPrincipalAuthenticated?.('rpc');
    const body = await bodyPromise;
    if (!body.ok) {
      jsonResponse(res, 413, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: body.error },
      });
      return;
    }
    const principalAfter = this.resolvePrincipalAfterBody(req, parsedUrl, principalBefore, 'rpc', res);
    if (!principalAfter) return;
    const response = await this.protocolGateway.dispatch(body.body, { client: principalAfter });
    jsonResponse(res, 200, response);
  }

  private handleCreateSession(req: IncomingMessage, res: ServerResponse): void {
    // Read body
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });

    req.on('end', () => {
      let projectRoot = '';
      try {
        if (body) {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          if (typeof parsed['projectRoot'] === 'string') {
            projectRoot = parsed['projectRoot'];
          }
        }
      } catch {
        // Use empty projectRoot
      }

      const session = sessionRunner.createSession(projectRoot || process.cwd());

      const wsUrl = `ws://127.0.0.1:${this._port}/ws?sessionId=${session.sessionId}`;

      this.options.onSessionCreated?.(session);

      jsonResponse(res, 201, {
        sessionId: session.sessionId,
        wsUrl,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
      });
    });
  }

  private handleListSessions(_req: IncomingMessage, res: ServerResponse): void {
    const sessions = sessionRunner.listSessions().map((s) => ({
      sessionId: s.sessionId,
      projectRoot: s.projectRoot,
      status: s.status,
      createdAt: s.createdAt.toISOString(),
      lastActiveAt: s.lastActiveAt.toISOString(),
      transport: s.transport,
    }));

    jsonResponse(res, 200, { sessions });
  }

  private handleGetSession(res: ServerResponse, sessionId: string): void {
    const session = sessionRunner.getSession(sessionId);
    if (!session) {
      errorResponse(res, 404, `Session '${sessionId}' not found`);
      return;
    }

    jsonResponse(res, 200, {
      sessionId: session.sessionId,
      projectRoot: session.projectRoot,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      lastActiveAt: session.lastActiveAt.toISOString(),
      transport: session.transport,
    });
  }

  private handleDeleteSession(res: ServerResponse, sessionId: string): void {
    const session = sessionRunner.getSession(sessionId);
    if (!session) {
      errorResponse(res, 404, `Session '${sessionId}' not found`);
      return;
    }

    // Remove associated WebSocket transport
    const wsTransport = this.wsTransports.get(sessionId);
    if (wsTransport) {
      wsTransport.close();
      this.wsTransports.delete(sessionId);
    }
    this.transportGenerations.delete(sessionId);

    sessionRunner.removeSession(sessionId, 'client request');
    jsonResponse(res, 200, { status: 'removed', sessionId });
  }

  // ── WebSocket upgrade handling ────────────────────────────────────────────

  /**
   * Handle an incoming WebSocket upgrade request.
   *
   * Expected V1 URL: /ws?sessionId=<id>&ticket=<short-lived-ticket>
   * Legacy tools may still send Authorization or ?token= but that path
   * does not subscribe to turn.event fan-out.
   */
  private handleWebSocketUpgrade(
    req: IncomingMessage,
    socket: import('node:net').Socket,
    head: Buffer,
  ): void {
    // Parse URL
    let parsedUrl: ParsedUrl | null = null;
    try {
      parsedUrl = parseRequestUrl(req);
    } catch {
      socket.destroy();
      return;
    }

    if (!parsedUrl || parsedUrl.pathname !== '/ws') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const origin = req.headers['origin'];
    if (!originAllowed(origin, this.allowedOrigins, socket.remoteAddress)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const ticketValue = parsedUrl.searchParams.get('ticket') ?? undefined;
    const headerToken = extractBearerToken(req.headers['authorization']);
    const sessionId = parsedUrl.searchParams.get('sessionId');
    if (!sessionId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const legacyBearer =
      this.options.allowLegacyWsBearer === true ||
      process.env['BABEL_REMOTE_ALLOW_LEGACY_WS_BEARER'] === '1';

    let subscribedThreadId: string | undefined;
    let wsClient: BridgeClientContext = { authKind: 'none', clientId: 'anonymous' };
    if (ticketValue) {
      const consumed = this.wsTickets.consume({
        ticket: ticketValue,
        sessionId,
        deviceAuthorized: (deviceId) => this.devicePairing.isDeviceAuthorized(deviceId),
      });
      if (!consumed.ok) {
        const status = consumed.error === 'missing' || consumed.error === 'unknown' ? 401 : 403;
        socket.write(`HTTP/1.1 ${status} Unauthorized\r\n\r\n`);
        socket.destroy();
        return;
      }
      subscribedThreadId = consumed.value.threadId;
      if (!isBridgeClientAuthenticated({
        authKind: consumed.value.authKind,
        clientId: consumed.value.clientId,
        ...(consumed.value.deviceId !== undefined
          ? { deviceId: consumed.value.deviceId }
          : {}),
      })) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wsClient = {
        authKind: consumed.value.authKind,
        clientId: consumed.value.clientId,
        ...(consumed.value.deviceId !== undefined
          ? { deviceId: consumed.value.deviceId }
          : {}),
      };
    } else if (legacyBearer && headerToken && verifyToken(headerToken, this.authToken)) {
      // Compatibility path: header bearer only. No thread-scoped events.
      subscribedThreadId = undefined;
      const digest = createHash('sha256').update(headerToken).digest('base64url');
      wsClient = { authKind: 'host_bearer', clientId: `host:${digest}` };
    } else {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Verify the session exists
    const session = sessionRunner.getSession(sessionId);
    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // Validate WebSocket key
    const wsKey = req.headers['sec-websocket-key'];
    if (!wsKey) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // Perform WebSocket upgrade handshake
    const acceptKey = computeWsAcceptKey(wsKey);
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      '',
    ].join('\r\n');

    socket.write(responseHeaders);
    // Consume any data that arrived before the upgrade completed
    if (head.length > 0) {
      socket.unshift(head);
    }

    // Create WebSocket transport wrapping the upgraded socket
    const transport = createTransport({
      type: 'ws',
      sessionId,
      socket,
    });

    // Close stale transport from a previous connection for the same session
    const existingTransport = this.wsTransports.get(sessionId);
    if (existingTransport) {
      existingTransport.close();
    }
    this.wsTransports.set(sessionId, transport);

    // Bump the transport generation so the stale onClose is a no-op
    const generation = (this.transportGenerations.get(sessionId) ?? 0) + 1;
    this.transportGenerations.set(sessionId, generation);

    const pairedDeviceId = wsClient.deviceId;

    const unsub =
      transport instanceof WebSocketTransport && subscribedThreadId
        ? this.protocolGateway.subscribe(
            (payload) => {
              if (
                pairedDeviceId &&
                !this.devicePairing.isDeviceAuthorized(pairedDeviceId)
              ) {
                transport.close();
                return;
              }
              transport.sendText(payload);
            },
            { threadId: subscribedThreadId },
          )
        : () => {};

    const closeBoundSocket = (): void => {
      transport.close();
    };

    if (transport instanceof WebSocketTransport) {
      if (pairedDeviceId) {
        this.registerDeviceSocket(pairedDeviceId, closeBoundSocket);
      }
      transport.onText((payload) => {
        if (wsClient.deviceId && !this.devicePairing.isDeviceAuthorized(wsClient.deviceId)) {
          transport.sendText(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32001, message: 'Device authorization revoked' },
            }),
          );
          transport.close();
          return;
        }
        const parsed = parseProtocolRequest(payload);
        const method = parsed && typeof parsed.method === 'string' ? parsed.method : '';
        if (subscribedThreadId) {
          const allowed = authorizeThreadScopedWsRpc(payload, {
            bridgeSessionId: sessionId,
            subscribedThreadId,
          });
          if (!allowed.ok) {
            transport.sendText(
              JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32001, message: allowed.message },
              }),
            );
            return;
          }
        } else if (REMOTE_MUTATING_RPC_METHODS.has(method)) {
          transport.sendText(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed && 'id' in parsed ? parsed.id : null,
              error: {
                code: -32001,
                message: 'Mutating RPC requires a thread-scoped WebSocket ticket',
              },
            }),
          );
          return;
        }
        void this.protocolGateway.dispatch(payload, { client: wsClient }).then((response) => {
          transport.sendText(JSON.stringify(response));
        });
      });
    }

    sessionRunner.updateSession(sessionId, { transport: 'ws' });

    const closeGeneration = generation;
    transport.onClose?.((_reason?: string) => {
      if (pairedDeviceId) {
        this.unregisterDeviceSocket(pairedDeviceId, closeBoundSocket);
      }
      if (this.transportGenerations.get(sessionId) !== closeGeneration) return;
      unsub();
      this.wsTransports.delete(sessionId);
      this.transportGenerations.delete(sessionId);
      sessionRunner.updateSession(sessionId, { status: 'idle' });
    });
  }
}
