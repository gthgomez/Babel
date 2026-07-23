/**
 * Shared env flag parsing so headless/CI checks stay consistent.
 */

/** True for 1 / true / yes / on (case-insensitive). */
export function isTruthyEnvFlag(value: string | undefined | null): boolean {
  if (value == null) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** True for 0 / false / off / no (case-insensitive). */
export function isFalsyEnvFlag(value: string | undefined | null): boolean {
  if (value == null) return false;
  const v = value.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/**
 * Headless mode for hard gates + mutation auto-approve.
 * Accepts BABEL_HEADLESS=1|true|yes|on and CI=1|true|yes|on.
 */
export function isBabelHeadlessEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvFlag(env['BABEL_HEADLESS']) || isTruthyEnvFlag(env['CI']);
}
