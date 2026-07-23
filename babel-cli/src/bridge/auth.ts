/**
 * Authentication for the Babel IDE Bridge.
 *
 * HMAC-SHA256 token generation and verification. Tokens are stored in
 * `~/.babel/bridge.json` and auto-generated on first bridge start if
 * not configured.
 *
 * Clients authenticate via `Authorization: Bearer <token>` header or
 * `?token=<token>` query parameter for WebSocket connections.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import type { BridgeConfigFile } from './types.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Path to the bridge configuration file. */
export function getBridgeConfigPath(): string {
  return join(homedir(), '.babel', 'bridge.json');
}

/** Default listen port. */
export const DEFAULT_BRIDGE_PORT = 4545;

/** Minimum token length in bytes before base64 encoding (32 bytes = 256 bits). */
const TOKEN_BYTE_LENGTH = 32;

/** HMAC algorithm used for token verification. */
const HMAC_ALGORITHM = 'sha256';

// ─── Bridge config file schema ─────────────────────────────────────────────────

const BridgeConfigFileSchema = z.object({
  port: z.number().int().min(1024).max(65535).optional(),
  authToken: z.string().min(16).optional(),
  allowedOrigins: z.array(z.string()).optional(),
});

// ─── Token operations ──────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random HMAC-SHA256 token.
 * Returns a base64url-encoded string suitable for bearer authentication.
 */
export function generateToken(): string {
  const bytes = randomBytes(TOKEN_BYTE_LENGTH);
  return bytes.toString('base64url');
}

/**
 * Compute the HMAC-SHA256 signature of a payload.
 *
 * The payload is the token value itself (symmetric). Used to verify
 * that a provided token matches the configured one without leaking
 * the stored token in error messages.
 */
export function signToken(token: string): string {
  return createHmac(HMAC_ALGORITHM, token).update('babel-bridge-auth').digest('hex');
}

/**
 * Verify a token against the expected value using timing-safe comparison.
 *
 * @param provided - The token provided by the client (from header or query).
 * @param expected - The stored token from configuration.
 * @returns true if the tokens match.
 */
export function verifyToken(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  try {
    const providedBuf = Buffer.from(provided, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');

    // Always call timingSafeEqual, regardless of length mismatch.
    // Pad the shorter buffer to match the longer one so the comparison
    // is constant-time in both length and content.
    const maxLen = Math.max(providedBuf.length, expectedBuf.length);
    const paddedProvided = Buffer.alloc(maxLen, 0);
    const paddedExpected = Buffer.alloc(maxLen, 0);
    providedBuf.copy(paddedProvided);
    expectedBuf.copy(paddedExpected);

    return timingSafeEqual(paddedProvided, paddedExpected);
  } catch {
    return false;
  }
}

// ─── Configuration loading ─────────────────────────────────────────────────────

/**
 * Load the bridge configuration from `~/.babel/bridge.json`.
 *
 * If the file does not exist or is malformed, returns a default configuration
 * with a freshly generated auth token. The caller can call
 * {@link persistBridgeConfig} to write the config back to disk.
 *
 * This function never throws — all errors are swallowed and returned as a
 * default config with a new token.
 */
export function loadBridgeConfig(): BridgeConfigFile {
  const configPath = getBridgeConfigPath();
  try {
    if (!existsSync(configPath)) {
      return { authToken: generateToken(), port: DEFAULT_BRIDGE_PORT };
    }
    const raw = readFileSync(configPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      // Malformed JSON — return defaults
      return { authToken: generateToken(), port: DEFAULT_BRIDGE_PORT };
    }
    const result = BridgeConfigFileSchema.safeParse(parsed);
    if (result.success) {
      const cfg = result.data;
      return {
        port: cfg.port ?? DEFAULT_BRIDGE_PORT,
        authToken: cfg.authToken ?? generateToken(),
        allowedOrigins: cfg.allowedOrigins ?? ['http://localhost:*'],
      };
    }
    // Schema validation failed — return defaults
    return { authToken: generateToken(), port: DEFAULT_BRIDGE_PORT };
  } catch {
    return { authToken: generateToken(), port: DEFAULT_BRIDGE_PORT };
  }
}

/**
 * Persist a bridge configuration to `~/.babel/bridge.json`.
 *
 * Creates the `~/.babel/` directory if it does not exist.
 * Best-effort — never throws.
 */
export function persistBridgeConfig(config: BridgeConfigFile): void {
  const configPath = getBridgeConfigPath();
  try {
    const dir = join(homedir(), '.babel');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch {
    // best-effort
  }
}

// ─── Token extraction helpers ──────────────────────────────────────────────────

/**
 * Extract a bearer token from an HTTP Authorization header.
 * Returns undefined when the header is missing or malformed.
 */
export function extractBearerToken(authorization?: string): string | undefined {
  if (!authorization) return undefined;
  const parts = authorization.split(' ');
  if (parts.length !== 2) return undefined;
  const [scheme, token] = parts;
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  return token;
}

/**
 * Extract a token from URL query parameters.
 * Returns undefined when the parameter is missing.
 */
export function extractQueryToken(url: URL): string | undefined {
  return url.searchParams.get('token') ?? undefined;
}
