/**
 * HTTP + WebSocket server for the Babel IDE Bridge.
 *
 * Serves as the remote control endpoint for IDEs, external tools, and
 * remote clients. Uses only Node.js built-in modules (`node:http`) —
 * no Express or third-party HTTP libraries.
 *
 * Endpoints:
 *   POST   /sessions          — Create a new bridge session
 *   GET    /sessions          — List active sessions
 *   GET    /sessions/:id      — Get session status
 *   DELETE /sessions/:id      — Stop and remove a session
 *   WS     /ws?sessionId=...  — WebSocket upgrade for bidirectional messaging
 *
 * Authentication: Bearer token via `Authorization` header or `?token=` query
 * parameter (HMAC-SHA256, configurable via `~/.babel/bridge.json`).
 *
 * Configuration:
 *   - Port:    BABEL_BRIDGE_PORT env var, or bridge.json port, or 4545
 *   - Token:   bridge.json authToken (auto-generated on first start)
 *   - Origins: bridge.json allowedOrigins (defaults to ['http://localhost:*'])
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type {
  BridgeMessage,
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
import { computeWsAcceptKey, createTransport } from './transport.js';
import { BridgeMessageRouter } from './messaging.js';
import { sessionRunner } from './sessionRunner.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface BridgeServerOptions {
  /** Listen port. Default: 4545 (or BABEL_BRIDGE_PORT env, or bridge.json). */
  port?: number;
  /** Auth token. Auto-generated if not provided. */
  authToken?: string;
  /** Allowed origins for CORS. */
  allowedOrigins?: string[];
  /** Register a callback for server lifecycle events. */
  onListening?: (port: number) => void;
  onError?: (error: Error) => void;
  onSessionCreated?: (session: BridgeSession) => void;
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

function isAuthenticated(
  req: IncomingMessage,
  authToken: string,
  parsedUrl?: ParsedUrl | null,
): boolean {
  // Check Authorization header first
  const headerToken = extractBearerToken(req.headers['authorization']);
  if (headerToken && verifyToken(headerToken, authToken)) return true;

  // Check query parameter
  if (parsedUrl) {
    const queryToken = extractQueryToken(
      new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`),
    );
    if (queryToken && verifyToken(queryToken, authToken)) return true;
  }

  return false;
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
    const allowed = allowedOrigins.some((ao) => {
      if (ao === '*') return true;
      if (ao.endsWith(':*')) {
        const prefix = ao.slice(0, -2);
        return origin.startsWith(prefix);
      }
      return ao === origin;
    });
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

  /** Active WebSocket transports keyed by session ID. */
  private wsTransports = new Map<string, BridgeTransport>();

  /** Message routers keyed by session ID. */
  private routers = new Map<string, BridgeMessageRouter>();

  /** Generation counter per session — prevents stale transport onClose from destroying the active router. */
  private transportGenerations = new Map<string, number>();

  constructor(options?: BridgeServerOptions) {
    this.options = options ?? {};

    // Load config from file, with env/option overrides
    const config = loadBridgeConfig();
    this.authToken =
      this.options.authToken ?? config.authToken ?? randomUUID();
    this.allowedOrigins = this.options.allowedOrigins ?? config.allowedOrigins ?? ['*'];

    this.server = createServer((req, res) => this.handleRequest(req, res));

    // Handle WebSocket upgrades
    this.server.on('upgrade', (req, socket, head) =>
      this.handleWebSocketUpgrade(req, socket as import('node:net').Socket, head),
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

    return new Promise<void>((resolve, reject) => {
      this.server.on('listening', () => {
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

      this.server.listen(resolvedPort, '127.0.0.1');
    });
  }

  /**
   * Stop the server and clean up all sessions.
   */
  async stop(): Promise<void> {
    // Close all WebSocket transports
    for (const transport of this.wsTransports.values()) {
      transport.close();
    }
    this.wsTransports.clear();
    this.transportGenerations.clear();

    // Close all routers
    for (const router of this.routers.values()) {
      router.close();
    }
    this.routers.clear();

    // Shutdown session runner
    sessionRunner.shutdown();

    return new Promise<void>((resolve) => {
      this.server.close(() => resolve());
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

    // CORS preflight
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res, req.headers['origin'], this.allowedOrigins);
      res.writeHead(204);
      res.end();
      return;
    }

    // Authenticate all non-OPTIONS requests
    if (!isAuthenticated(req, this.authToken, parsedUrl)) {
      setCorsHeaders(res, req.headers['origin'], this.allowedOrigins);
      errorResponse(res, 401, 'Unauthorized — provide a valid Bearer token');
      return;
    }

    setCorsHeaders(res, req.headers['origin'], this.allowedOrigins);

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

  // ── Session endpoints ─────────────────────────────────────────────────────

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

    // Remove associated router
    const router = this.routers.get(sessionId);
    if (router) {
      router.close();
      this.routers.delete(sessionId);
    }

    sessionRunner.removeSession(sessionId, 'client request');
    jsonResponse(res, 200, { status: 'removed', sessionId });
  }

  // ── WebSocket upgrade handling ────────────────────────────────────────────

  /**
   * Handle an incoming WebSocket upgrade request.
   *
   * Expected URL: /ws?sessionId=<id>&token=<auth-token>
   *
   * The session ID identifies which bridge session this WebSocket
   * should connect to. The token can be provided as a query parameter
   * or via the Authorization header (set by the WebSocket client).
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

    // Authenticate FIRST (token from query param or header)
    const queryToken = parsedUrl.searchParams.get('token') ?? undefined;
    const headerToken = extractBearerToken(req.headers['authorization']);
    const providedToken = queryToken ?? headerToken;

    if (!providedToken || !verifyToken(providedToken, this.authToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Extract session ID from query
    const sessionId = parsedUrl.searchParams.get('sessionId');
    if (!sessionId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
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

    // Create or reuse a message router for this session
    let router = this.routers.get(sessionId);
    if (!router) {
      router = new BridgeMessageRouter(sessionId);
      this.routers.set(sessionId, router);

      // Wire ingress: client → router → session runner
      router.onIngress((msg) => {
        sessionRunner.echoToClient(sessionId, msg);
      });
    }

    // Re-register egress on every connection so the closure captures
    // the current transport, not a stale first-connection reference.
    router.onEgress((msg) => {
      transport.send(msg);
    });

    // Attach client transport to router
    router.attachClient(transport);

    // Attach session-side transport to router (in-process for now)
    const inprocTransport = createTransport({ type: 'inproc', sessionId });
    router.attachSession(inprocTransport);

    // Wire the inproc transport's ingress to the session runner
    inprocTransport.onMessage((msg: BridgeMessage) => {
      transport.send(msg);
    });

    // Update session transport type
    sessionRunner.updateSession(sessionId, { transport: 'ws' });

    // Handle transport close
    const closeGeneration = generation;
    transport.onClose?.((_reason?: string) => {
      // Only cleanup if this is still the active transport generation
      if (this.transportGenerations.get(sessionId) !== closeGeneration) return;

      this.wsTransports.delete(sessionId);
      this.transportGenerations.delete(sessionId);
      router?.close();
      this.routers.delete(sessionId);
      sessionRunner.updateSession(sessionId, { status: 'idle' });
    });
  }
}
