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

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { enforceOwnerOnlyWindowsAcl } from '../runtime/windowsOwnerAcl.js';
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

export interface BridgeAclOptions {
  /** Injection seam for isolated ACL ordering/failure tests. */
  readonly enforceAcl?: (path: string, directory: boolean) => { ok: boolean; code: string };
}

class BridgeAclError extends Error {
  constructor(code: string) {
    super(`Bridge credential ACL could not be verified (${code})`);
    this.name = 'BridgeAclError';
  }
}

function aclEnforcer(options?: BridgeAclOptions): BridgeAclOptions['enforceAcl'] {
  if (process.platform !== 'win32') return options?.enforceAcl;
  if (!options?.enforceAcl) return enforceOwnerOnlyWindowsAcl;
  // The fixture hook can add checks but never replace the real Windows DACL
  // operation or turn a native ACL failure into success.
  return (path, directory) => {
    const nativeResult = enforceOwnerOnlyWindowsAcl(path, directory);
    if (!nativeResult.ok) return nativeResult;
    return options.enforceAcl!(path, directory);
  };
}

function enforceAcl(path: string, directory: boolean, apply?: BridgeAclOptions['enforceAcl']): void {
  if (!apply) return;
  const result = apply(path, directory);
  if (!result.ok) throw new BridgeAclError(result.code);
}

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
    if (providedBuf.length !== expectedBuf.length) {
      timingSafeEqual(expectedBuf, expectedBuf);
      return false;
    }
    return timingSafeEqual(providedBuf, expectedBuf);
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
 * Ordinary load/parse failures return a fresh default token. ACL failures throw
 * so callers never silently rotate a token when its protection is unknown.
 */
export function loadBridgeConfig(options?: BridgeAclOptions): BridgeConfigFile {
  const configPath = getBridgeConfigPath();
  const applyAcl = aclEnforcer(options);
  try {
    const dir = join(homedir(), '.babel');
    if (!existsSync(dir)) {
      return { authToken: generateToken(), port: DEFAULT_BRIDGE_PORT };
    }
    assertPrivateBridgeDirectory(dir, false, applyAcl);
    if (!pathEntryExists(configPath)) return { authToken: generateToken(), port: DEFAULT_BRIDGE_PORT };
    enforceAcl(configPath, false, applyAcl);
    const fd = openPrivateBridgeConfig(configPath);
    let raw: string;
    try {
      raw = readFileSync(fd, 'utf-8');
    } finally {
      closeSync(fd);
    }
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
  } catch (error) {
    if (error instanceof BridgeAclError) throw error;
    return { authToken: generateToken(), port: DEFAULT_BRIDGE_PORT };
  }
}

/**
 * Persist a bridge configuration to `~/.babel/bridge.json`.
 *
 * Creates the `~/.babel/` directory if needed and atomically replaces the
 * config using a unique private temporary file. Windows directories and files
 * use the shared verified owner-only DACL helper. Persistence errors throw.
 */
export function persistBridgeConfig(config: BridgeConfigFile, options?: BridgeAclOptions): void {
  const configPath = getBridgeConfigPath();
  const dir = join(homedir(), '.babel');
  const applyAcl = aclEnforcer(options);
  assertPrivateBridgeDirectory(dir, true, applyAcl);
  let existingConfig: Buffer | undefined;
  if (pathEntryExists(configPath)) {
    enforceAcl(configPath, false, applyAcl);
    assertPrivateBridgeConfigFile(configPath);
    const existingFd = openPrivateBridgeConfig(configPath);
    try {
      existingConfig = readFileSync(existingFd);
    } finally {
      closeSync(existingFd);
    }
  }
  const tempPath = join(dir, `.bridge.json.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let renamed = false;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    fd = openSync(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
    const tempStats = fstatSync(fd);
    if (!tempStats.isFile() || (typeof process.getuid === 'function' && tempStats.uid !== process.getuid())) {
      throw new Error('Bridge config temporary file ownership is invalid');
    }
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    // The temp file is still empty here: protect and verify its DACL before
    // any token bytes are written.
    enforceAcl(tempPath, false, applyAcl);
    writeFileSync(fd, JSON.stringify(config, null, 2), 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, configPath);
    renamed = true;
    enforceAcl(configPath, false, applyAcl);
    if (process.platform !== 'win32') {
      const dirFd = openSync(dir, fsConstants.O_RDONLY);
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    }
  } catch (error) {
    let rollbackFailed = false;
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Retain the original persistence failure.
      }
    }
    if (renamed) {
      if (existingConfig) {
        const restored = restoreBridgeConfig(configPath, dir, existingConfig, applyAcl);
        rollbackFailed = !restored;
      } else {
        try {
          unlinkSync(configPath);
        } catch {
          // Retain the original persistence failure.
        }
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    if (rollbackFailed) throw new Error('Bridge credential persistence failed; rollback could not be completed');
    if (error instanceof BridgeAclError) throw error;
    throw new Error('Bridge credential persistence failed');
  }
}

function restoreBridgeConfig(
  configPath: string,
  dir: string,
  previousContents: Buffer,
  applyAcl?: BridgeAclOptions['enforceAcl'],
): boolean {
  const rollbackPath = join(dir, `.bridge.json.${randomUUID()}.rollback`);
  let fd: number | undefined;
  let restored = false;
  try {
    fd = openSync(rollbackPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    enforceAcl(rollbackPath, false, applyAcl);
    writeFileSync(fd, previousContents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(rollbackPath, configPath);
    restored = true;
  } catch {
    // The original persistence failure remains authoritative. Do not delete a
    // backup or the prior config to hide a failed rollback.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort cleanup */ }
    }
    if (restored) {
      try { unlinkSync(rollbackPath); } catch { /* absent after successful rename */ }
    }
  }
  return restored;
}

function assertPrivateBridgeDirectory(dir: string, create: boolean, applyAcl?: BridgeAclOptions['enforceAcl']): void {
  if (!existsSync(dir) && create) mkdirSync(dir, { mode: 0o700 });
  const stats = lstatSync(dir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('Bridge config directory must be an owned directory, not a symlink');
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error('Bridge config directory is not owned by the current user');
  }
  if (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o700) {
    chmodSync(dir, 0o700);
  }
  enforceAcl(dir, true, applyAcl);
}

function assertPrivateBridgeConfigFile(configPath: string, repairPermissions = true): void {
  const fd = openPrivateBridgeConfig(configPath, repairPermissions);
  closeSync(fd);
}

function openPrivateBridgeConfig(configPath: string, repairPermissions = true): number {
  const entry = lstatSync(configPath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error('Bridge config must be a regular file, not a symlink');
  }
  const fd = openSync(configPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || (typeof process.getuid === 'function' && stats.uid !== process.getuid())) {
      throw new Error('Bridge config file ownership or type is invalid');
    }
    if (repairPermissions && process.platform !== 'win32' && (stats.mode & 0o777) !== 0o600) {
      fchmodSync(fd, 0o600);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
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
