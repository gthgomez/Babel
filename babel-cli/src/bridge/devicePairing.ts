/**
 * Short-lived device pairing for Babel Remote (no permanent bearer tokens in URLs).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PairingChallenge {
  challengeId: string;
  createdAtMs: number;
  expiresAtMs: number;
  deviceLabel?: string;
  approved: boolean;
  consumed: boolean;
  approvedDeviceId?: string;
}

export interface PairedDevice {
  deviceId: string;
  label: string;
  createdAtMs: number;
  lastSeenAtMs: number;
  revoked: boolean;
}

export interface DeviceSession {
  sessionToken: string;
  deviceId: string;
  expiresAtMs: number;
}

interface PairingStoreFile {
  devices: PairedDevice[];
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function pairingDir(): string {
  return join(homedir(), '.babel', 'bridge');
}

function pairingStorePath(): string {
  return join(pairingDir(), 'paired-devices.json');
}

function loadStore(): PairingStoreFile {
  const path = pairingStorePath();
  if (!existsSync(path)) return { devices: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PairingStoreFile;
  } catch {
    return { devices: [] };
  }
}

function saveStore(store: PairingStoreFile): void {
  const dir = pairingDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(pairingStorePath(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

function signSession(deviceId: string, expiresAtMs: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${deviceId}:${expiresAtMs}:babel-remote-pair`)
    .digest('base64url');
}

export class DevicePairingService {
  private readonly challenges = new Map<string, PairingChallenge>();
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly sessionSecret: string;

  constructor(sessionSecret: string) {
    this.sessionSecret = sessionSecret;
  }

  createChallenge(): PairingChallenge {
    const now = Date.now();
    const challenge: PairingChallenge = {
      challengeId: randomBytes(16).toString('base64url'),
      createdAtMs: now,
      expiresAtMs: now + CHALLENGE_TTL_MS,
      approved: false,
      consumed: false,
    };
    this.challenges.set(challenge.challengeId, challenge);
    return challenge;
  }

  getChallenge(challengeId: string): PairingChallenge | undefined {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) return undefined;
    if (challenge.expiresAtMs < Date.now()) {
      this.challenges.delete(challengeId);
      return undefined;
    }
    return challenge;
  }

  requestPairing(challengeId: string, deviceLabel: string): { ok: true } | { ok: false; error: string } {
    const challenge = this.getChallenge(challengeId);
    if (!challenge) return { ok: false, error: 'expired_or_missing' };
    if (challenge.consumed) return { ok: false, error: 'already_consumed' };
    challenge.deviceLabel = deviceLabel.slice(0, 120);
    return { ok: true };
  }

  approveChallenge(challengeId: string): { ok: true; device: PairedDevice } | { ok: false; error: string } {
    const challenge = this.getChallenge(challengeId);
    if (!challenge) return { ok: false, error: 'expired_or_missing' };
    if (!challenge.deviceLabel) return { ok: false, error: 'pending_label' };
    challenge.approved = true;
    const store = loadStore();
    const device: PairedDevice = {
      deviceId: randomBytes(12).toString('base64url'),
      label: challenge.deviceLabel,
      createdAtMs: Date.now(),
      lastSeenAtMs: Date.now(),
      revoked: false,
    };
    store.devices.push(device);
    saveStore(store);
    challenge.approvedDeviceId = device.deviceId;
    return { ok: true, device };
  }

  exchangeChallenge(
    challengeId: string,
  ): { ok: true; session: DeviceSession } | { ok: false; error: string } {
    const challenge = this.getChallenge(challengeId);
    if (!challenge || !challenge.approved || !challenge.approvedDeviceId) {
      return { ok: false, error: 'not_approved' };
    }
    if (challenge.consumed) return { ok: false, error: 'already_consumed' };
    const store = loadStore();
    const device = store.devices.find(
      (d) => d.deviceId === challenge.approvedDeviceId && !d.revoked,
    );
    if (!device) return { ok: false, error: 'device_revoked' };
    challenge.consumed = true;
    const expiresAtMs = Date.now() + SESSION_TTL_MS;
    const sessionToken = signSession(device.deviceId, expiresAtMs, this.sessionSecret);
    const session: DeviceSession = { sessionToken, deviceId: device.deviceId, expiresAtMs };
    this.sessions.set(sessionToken, session);
    this.challenges.delete(challengeId);
    return { ok: true, session };
  }

  listDevices(): PairedDevice[] {
    return loadStore().devices.filter((d) => !d.revoked);
  }

  revokeDevice(deviceId: string): boolean {
    const store = loadStore();
    const device = store.devices.find((d) => d.deviceId === deviceId);
    if (!device) return false;
    device.revoked = true;
    saveStore(store);
    for (const [token, session] of this.sessions) {
      if (session.deviceId === deviceId) this.sessions.delete(token);
    }
    return true;
  }

  verifySessionToken(token: string): { ok: true; deviceId: string } | { ok: false } {
    const session = this.sessions.get(token);
    if (!session || session.expiresAtMs < Date.now()) {
      this.sessions.delete(token);
      return { ok: false };
    }
    const expected = signSession(session.deviceId, session.expiresAtMs, this.sessionSecret);
    try {
      const a = Buffer.from(token, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
    } catch {
      return { ok: false };
    }
    const store = loadStore();
    const device = store.devices.find((d) => d.deviceId === session.deviceId && !d.revoked);
    if (!device) return { ok: false };
    device.lastSeenAtMs = Date.now();
    saveStore(store);
    return { ok: true, deviceId: session.deviceId };
  }

  challengeStatus(challengeId: string): {
    state: 'missing' | 'pending' | 'awaiting_approval' | 'approved' | 'consumed';
    deviceLabel?: string;
  } {
    const challenge = this.getChallenge(challengeId);
    if (!challenge) return { state: 'missing' };
    if (challenge.consumed) return { state: 'consumed' };
    if (challenge.approved) {
      return challenge.deviceLabel
        ? { state: 'approved', deviceLabel: challenge.deviceLabel }
        : { state: 'approved' };
    }
    if (challenge.deviceLabel) return { state: 'awaiting_approval', deviceLabel: challenge.deviceLabel };
    return { state: 'pending' };
  }
}

export const REMOTE_PAIRING_COOKIE = 'babel_remote_session';
