export const babelDusk = {
    name: 'babel-dusk',
    mode: 'dark',
    trueColor: {
        background: '#0B0A16',
        panel: '#151326',
        panelRaised: '#1C1933',
        border: '#5F5F87',
        textPrimary: '#F2EFFF',
        textMuted: '#AFAFD7',
        textGhost: '#5F5F87',
        accent: '#D7AFFF',
        accentSecondary: '#AFAFFF',
        accentActive: '#AF87FF',
        accentStrong: '#AF5FD7',
        info: '#87D7FF',
        success: '#87D787',
        warning: '#FFD75F',
        error: '#FF5F87',
    },
    ansiFallback: {
        textPrimary: 255,
        textMuted: 146,
        textGhost: 60,
        border: 60,
        accent: 183,
        accentSecondary: 147,
        accentActive: 141,
        accentStrong: 134,
        info: 117,
        success: 114,
        warning: 221,
        error: 204,
    },
};

export const BUILTIN_THEMES = {
    [babelDusk.name]: babelDusk,
};

export function resolveBuiltinTheme(name = babelDusk.name) {
    const theme = BUILTIN_THEMES[name];
    if (!theme) {
        throw new Error(`Unknown Babel theme "${name}". Valid themes: ${Object.keys(BUILTIN_THEMES).join(', ')}`);
    }
    return theme;
}

export function previewBuiltinTheme(name = babelDusk.name) {
    const theme = resolveBuiltinTheme(name);
    return [
        `${theme.name} (${theme.mode})`,
        `title: ${theme.trueColor.accent} / ${theme.ansiFallback.accent}`,
        `section: ${theme.trueColor.accentSecondary} / ${theme.ansiFallback.accentSecondary}`,
        `active: ${theme.trueColor.accentActive} / ${theme.ansiFallback.accentActive}`,
        `command: ${theme.trueColor.accentStrong} / ${theme.ansiFallback.accentStrong}`,
        `path: ${theme.trueColor.info} / ${theme.ansiFallback.info}`,
        `passed: ${theme.trueColor.success} / ${theme.ansiFallback.success}`,
        `failed: ${theme.trueColor.error} / ${theme.ansiFallback.error}`,
    ].join('\n');
}

const activeTheme = babelDusk;

export const COLOR_TOKENS = {
    ...activeTheme.trueColor,
    // Compatibility aliases used by the older UI modules.
    accentGold: activeTheme.trueColor.accentStrong,
    accentGoldBright: activeTheme.trueColor.accent,
    accentBlue: activeTheme.trueColor.info,
};
export const FALLBACK_FG = {
    ...activeTheme.ansiFallback,
    // Compatibility aliases used by the older UI modules.
    accentGold: activeTheme.ansiFallback.accentStrong,
    accentGoldBright: activeTheme.ansiFallback.accent,
    accentBlue: activeTheme.ansiFallback.info,
};
export const BADGE_TONES = {
    PASS: 'success',
    ACTIVE: 'accentActive',
    PENDING: 'textMuted',
    FAIL: 'error',
    BLOCKED: 'warning',
    VERIFIED: 'success',
    DIRECT: 'textMuted',
    AUTONOMOUS: 'accentActive',
};
export const STAGE_STATE_SYMBOLS = {
    PASS: '●',
    ACTIVE: '◐',
    PENDING: '○',
    FAIL: '✕',
    BLOCKED: '■',
};
export const PIPELINE_STAGES = [
    'Route',
    'Plan',
    'Review',
    'Apply',
];
