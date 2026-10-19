import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read loopback bridge host bearer for explicit local-admin emergency stop (main process only). */
export function readBridgeHostAuthToken(configDirectory) {
  if (typeof configDirectory !== 'string' || !configDirectory) return null;
  try {
    const raw = readFileSync(join(configDirectory, 'bridge.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const token = parsed?.authToken;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  }
}
