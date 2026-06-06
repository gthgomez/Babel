import { BADGE_TONES } from './tokens.js';
import { colorToken, bold } from './theme.js';
export function normalizeBadgeStatus(status) {
    const normalized = String(status ?? 'PENDING').trim().toUpperCase();
    if (normalized === 'REJECT') {
        return 'FAIL';
    }
    if (normalized === 'WARN' || normalized === 'WARNING') {
        return 'BLOCKED';
    }
    if (normalized === 'COMPLETE') {
        return 'PASS';
    }
    if (normalized === 'ERROR' || normalized === 'FAILED') {
        return 'FAIL';
    }
    return BADGE_TONES[normalized] ? normalized : 'PENDING';
}
export function renderBadge(status) {
    const normalized = normalizeBadgeStatus(status);
    return bold(colorToken(BADGE_TONES[normalized], `[${normalized}]`));
}
