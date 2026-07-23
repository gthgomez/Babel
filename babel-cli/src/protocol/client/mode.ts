/** True when chat should use direct ChatEngine imports (default migration path). */
export function isInProcessMode(): boolean {
  const raw = process.env['BABEL_INPROCESS'];
  if (raw === undefined || raw === '') return true;
  return raw === '1' || raw?.toLowerCase() === 'true' || raw?.toLowerCase() === 'yes';
}

/**
 * Protocol client path — opt-in during in-process migration (D2 stub host).
 * Set BABEL_PROTOCOL_CLIENT=1 to enable JSON-RPC notifications and thread allocation.
 */
export function isProtocolClientEnabled(): boolean {
  if (!isInProcessMode()) return true;
  const raw = process.env['BABEL_PROTOCOL_CLIENT'];
  if (raw === '1' || raw?.toLowerCase() === 'true' || raw?.toLowerCase() === 'yes') {
    return true;
  }
  return false;
}