import stringWidth from 'string-width';
import wrapAnsiLib from 'wrap-ansi';
import { COLOR_TOKENS, FALLBACK_FG } from './tokens.js';
function parseRgb(hex) {
    const normalized = hex.replace('#', '');
    return {
        r: Number.parseInt(normalized.slice(0, 2), 16),
        g: Number.parseInt(normalized.slice(2, 4), 16),
        b: Number.parseInt(normalized.slice(4, 6), 16),
    };
}
function wrapAnsi(text, open, close) {
    if (!text)
        return text;
    return `${open}${text}${close}`;
}
function getForceColorLevel() {
    const raw = process.env['FORCE_COLOR'];
    if (raw === undefined)
        return null;
    if (raw === '' || raw === 'true')
        return 1;
    if (raw === 'false')
        return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 1;
}
export function supportsColor(stream = process.stdout) {
    const forceColorLevel = getForceColorLevel();
    if (forceColorLevel === 0)
        return false;
    if (process.env['NO_COLOR'])
        return false;
    if (forceColorLevel !== null)
        return forceColorLevel > 0;
    return Boolean(stream?.isTTY);
}
export function supportsTrueColor(stream = process.stdout) {
    const forceColorLevel = getForceColorLevel();
    if (!supportsColor(stream))
        return false;
    if (forceColorLevel !== null)
        return forceColorLevel >= 2;
    const colorterm = (process.env['COLORTERM'] ?? '').toLowerCase();
    return colorterm.includes('truecolor') || colorterm.includes('24bit');
}
const HAS_COLOR = supportsColor();
const HAS_TRUE = supportsTrueColor();
function toneToAnsi(tokenName, text) {
    if (!HAS_COLOR) {
        return text;
    }
    const tokenHex = COLOR_TOKENS[tokenName];
    if (!tokenHex) {
        return text;
    }
    if (HAS_TRUE) {
        const rgb = parseRgb(tokenHex);
        return wrapAnsi(text, `\u001B[38;2;${rgb.r};${rgb.g};${rgb.b}m`, '\u001B[39m');
    }
    const fallback = FALLBACK_FG[tokenName] ?? 255;
    return wrapAnsi(text, `\u001B[38;5;${fallback}m`, '\u001B[39m');
}
export function bold(text) {
    return HAS_COLOR ? wrapAnsi(text, '\u001B[1m', '\u001B[22m') : text;
}
export function dim(text) {
    return HAS_COLOR ? wrapAnsi(text, '\u001B[2m', '\u001B[22m') : text;
}
export function colorToken(tokenName, text, options = {}) {
    const toned = toneToAnsi(tokenName, text);
    if (options.bold === true) {
        return bold(toned);
    }
    if (options.dim === true) {
        return dim(toned);
    }
    return toned;
}
export function primary(text) {
    return colorToken('textPrimary', text);
}
export function muted(text) {
    return colorToken('textMuted', text);
}
export function ghost(text) {
    return colorToken('textGhost', text);
}
export function accent(text) {
    return colorToken('accent', text);
}
export function accentBright(text) {
    return colorToken('accent', text, { bold: true });
}
export function accentBlue(text) {
    return colorToken('info', text);
}
export function sectionLabel(text) {
    return colorToken('accentSecondary', text, { bold: true });
}
export function activeAccent(text) {
    return colorToken('accentActive', text, { bold: true });
}
export function commandAccent(text) {
    return colorToken('accentStrong', text, { bold: true });
}
export function info(text) {
    return colorToken('info', text);
}
export function border(text) {
    return colorToken('border', text);
}
export function success(text) {
    return colorToken('success', text, { bold: true });
}
export function warning(text) {
    return colorToken('warning', text, { bold: true });
}
export function error(text) {
    return colorToken('error', text, { bold: true });
}
export function stripAnsi(text) {
    return text.replace(/\u001B\[[0-9;]*m/g, '');
}
export function visibleLength(text) {
    return stringWidth(stripAnsi(text));
}
export function getTerminalWidth(fallback = 88, stream = process.stdout) {
    const width = stream?.columns;
    if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
        return width;
    }
    return fallback;
}
export function truncate(text, maxWidth) {
    if (maxWidth <= 0)
        return '';
    const plain = stripAnsi(text);
    if (stringWidth(plain) <= maxWidth)
        return text;
    if (maxWidth === 1)
        return '…';
    const truncated = [...plain].slice(0, Math.max(0, maxWidth - 1)).join('') + '\u2026';
    // Re-apply leading ANSI open sequences so color isn't lost after truncation.
    const openSeq = text.match(/^(\u001B\[[0-9;]*m)+/)?.[0];
    return openSeq ? `${openSeq}${truncated}\u001B[39m` : truncated;
}
export function wrapText(text, maxWidth) {
    return wrapAnsiLib(String(text ?? ''), maxWidth, { hard: true }).split('\n');
}
export function formatOverflow(text, maxWidth, mode = 'truncate') {
    const normalizedMode = String(mode ?? 'truncate').toLowerCase();
    if (normalizedMode === 'full') {
        // Preserve original styling — do not strip ANSI.
        return [String(text ?? '')];
    }
    if (normalizedMode === 'wrap') {
        return wrapText(text, maxWidth);
    }
    return [truncate(String(text ?? ''), maxWidth)];
}
export function padRight(text, width) {
    const deficit = Math.max(0, width - visibleLength(text));
    return `${text}${' '.repeat(deficit)}`;
}
export function indentBlock(text, prefix = '  ') {
    return text
        .split('\n')
        .map(line => `${prefix}${line}`)
        .join('\n');
}
export function renderRule(width = 18, char = '─') {
    return muted(char.repeat(Math.max(0, width)));
}
