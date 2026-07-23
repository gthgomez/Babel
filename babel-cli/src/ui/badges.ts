import { BADGE_TONES } from './tokens.js';
import { colorToken, bold } from './theme.js';

export type BadgeStatus = string;

export function normalizeBadgeStatus(status: BadgeStatus): string {
  const normalized = String(status ?? 'READY')
    .trim()
    .toUpperCase();
  if (normalized === 'REJECT') return 'FAIL';
  if (normalized === 'WARN' || normalized === 'WARNING') return 'BLOCKED';
  if (normalized === 'COMPLETE') return 'PASS';
  if (normalized === 'ERROR' || normalized === 'FAILED') return 'FAIL';
  if (normalized === 'READY') return 'READY';
  return BADGE_TONES[normalized] ? normalized : 'PENDING';
}

export function renderBadge(status: BadgeStatus): string {
  const normalized = normalizeBadgeStatus(status);
  return bold(colorToken(BADGE_TONES[normalized]!, `[${normalized}]`));
}
