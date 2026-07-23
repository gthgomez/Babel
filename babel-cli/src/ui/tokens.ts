export interface ThemeDefinition {
  name: string;
  mode: 'dark' | 'light';
  trueColor: Record<string, string>;
  ansiFallback: Record<string, number>;
}

export const babelDusk: ThemeDefinition = {
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

export const babelDawn: ThemeDefinition = {
  name: 'babel-dawn',
  mode: 'light',
  trueColor: {
    background: '#F5F3FF',
    panel: '#EDEAFA',
    panelRaised: '#E4E0F5',
    border: '#AFAFD7',
    textPrimary: '#1A1530',
    textMuted: '#5F5F87',
    textGhost: '#AFAFD7',
    accent: '#7B4FBF',
    accentSecondary: '#6B5FCF',
    accentActive: '#5F3FAF',
    accentStrong: '#AF2F8F',
    info: '#2F6FAF',
    success: '#2F7F4F',
    warning: '#AF8F2F',
    error: '#CF3F5F',
  },
  ansiFallback: {
    textPrimary: 0,
    textMuted: 8,
    textGhost: 7,
    border: 7,
    accent: 5,
    accentSecondary: 4,
    accentActive: 5,
    accentStrong: 5,
    info: 6,
    success: 2,
    warning: 3,
    error: 1,
  },
};

export const babelDuskDaltonized: ThemeDefinition = {
  name: 'babel-dusk-daltonized',
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
    success: '#87AFFF', // blue (was green #87D787) -- deuteranopia-safe
    warning: '#FFD75F', // amber (unchanged; use with icon/shape distinction)
    error: '#FF875F', // orange (was red #FF5F87) -- deuteranopia-safe
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
    success: 111, // light blue (was 114 green)
    warning: 221, // yellow  (unchanged)
    error: 209, // orange  (was 204 red)
  },
};

export const babelDawnDaltonized: ThemeDefinition = {
  name: 'babel-dawn-daltonized',
  mode: 'light',
  trueColor: {
    background: '#F5F3FF',
    panel: '#EDEAFA',
    panelRaised: '#E4E0F5',
    border: '#AFAFD7',
    textPrimary: '#1A1530',
    textMuted: '#5F5F87',
    textGhost: '#AFAFD7',
    accent: '#7B4FBF',
    accentSecondary: '#6B5FCF',
    accentActive: '#5F3FAF',
    accentStrong: '#AF2F8F',
    info: '#2F6FAF',
    success: '#3F7FCF', // blue (was green #2F7F4F) -- deuteranopia-safe
    warning: '#AF8F2F', // amber (unchanged; use with icon/shape distinction)
    error: '#BF6F3F', // orange (was red #CF3F5F) -- deuteranopia-safe
  },
  ansiFallback: {
    textPrimary: 0,
    textMuted: 8,
    textGhost: 7,
    border: 7,
    accent: 5,
    accentSecondary: 4,
    accentActive: 5,
    accentStrong: 5,
    info: 6,
    success: 12, // bright blue (was 2 green)
    warning: 3, // yellow  (unchanged)
    error: 9, // orange  (was 1 red)
  },
};

/**
 * High-contrast dark theme. Meets WCAG AA 4.5:1 minimum contrast ratio
 * on dark backgrounds. Uses pure white text on near-black for maximum
 * legibility. Accent colors are selected for ≥7:1 contrast (AAA level).
 */
export const babelHc: ThemeDefinition = {
  name: 'babel-hc',
  mode: 'dark',
  trueColor: {
    background: '#0A0A0A', // near-black — luminance 0.001
    panel: '#141414', // slightly lighter for depth
    panelRaised: '#1E1E1E',
    border: '#C0C0C0', // silver — contrast ~16:1 on bg
    textPrimary: '#FFFFFF', // pure white — contrast ~21:1
    textMuted: '#D0D0D0', // light gray — contrast ~16:1
    textGhost: '#A0A0A0', // medium gray — contrast ~10:1
    accent: '#87CEFF', // light sky blue — contrast ~12:1
    accentSecondary: '#B0B0FF', // light periwinkle
    accentActive: '#9FC5FF', // brighter blue
    accentStrong: '#FFB0D0', // light pink
    info: '#87D7FF', // light blue
    success: '#7FFF7F', // light green — contrast ~14:1
    warning: '#FFFF60', // bright yellow — contrast ~19:1
    error: '#FF7070', // light red — contrast ~9:1
  },
  ansiFallback: {
    textPrimary: 15, // bright white
    textMuted: 7, // white
    textGhost: 8, // bright black (gray)
    border: 7, // white
    accent: 12, // bright blue
    accentSecondary: 13, // bright magenta
    accentActive: 12, // bright blue
    accentStrong: 13, // bright magenta
    info: 14, // bright cyan
    success: 10, // bright green
    warning: 11, // bright yellow
    error: 9, // bright red
  },
};

export const BUILTIN_THEMES: Record<string, ThemeDefinition> = {
  [babelDusk.name]: babelDusk,
  [babelDawn.name]: babelDawn,
  [babelDuskDaltonized.name]: babelDuskDaltonized,
  [babelDawnDaltonized.name]: babelDawnDaltonized,
  [babelHc.name]: babelHc,
};

export function resolveBuiltinTheme(name: string = babelDusk.name): ThemeDefinition {
  const theme = BUILTIN_THEMES[name];
  if (!theme) {
    throw new Error(
      `Unknown Babel theme "${name}". Valid themes: ${Object.keys(BUILTIN_THEMES).join(', ')}`,
    );
  }
  return theme;
}

export function previewBuiltinTheme(name: string = babelDusk.name): string {
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

let _activeThemeName: string = process.env['BABEL_THEME'] || babelDusk.name;
let _activeTheme: ThemeDefinition = resolveBuiltinTheme(_activeThemeName);

export function getActiveTheme(): ThemeDefinition {
  return _activeTheme;
}

export function setActiveTheme(name: string): void {
  _activeTheme = resolveBuiltinTheme(name);
  _activeThemeName = name;
  // Recompute exported tokens
  Object.assign(COLOR_TOKENS, {
    ..._activeTheme.trueColor,
    accentGold: _activeTheme.trueColor.accentStrong,
    accentGoldBright: _activeTheme.trueColor.accent,
    accentBlue: _activeTheme.trueColor.info,
  });
  Object.assign(FALLBACK_FG, {
    ..._activeTheme.ansiFallback,
    accentGold: _activeTheme.ansiFallback.accentStrong,
    accentGoldBright: _activeTheme.ansiFallback.accent,
    accentBlue: _activeTheme.ansiFallback.info,
  });
}

const activeTheme = _activeTheme;

export const COLOR_TOKENS: Record<string, string | undefined> = {
  ...activeTheme.trueColor,
  // Compatibility aliases used by the older UI modules.
  accentGold: activeTheme.trueColor.accentStrong,
  accentGoldBright: activeTheme.trueColor.accent,
  accentBlue: activeTheme.trueColor.info,
};

export const FALLBACK_FG: Record<string, number | undefined> = {
  ...activeTheme.ansiFallback,
  // Compatibility aliases used by the older UI modules.
  accentGold: activeTheme.ansiFallback.accentStrong,
  accentGoldBright: activeTheme.ansiFallback.accent,
  accentBlue: activeTheme.ansiFallback.info,
};

export const BADGE_TONES: Record<string, string> = {
  PASS: 'success',
  ACTIVE: 'accentActive',
  PENDING: 'textMuted',
  READY: 'accentActive',
  FAIL: 'error',
  BLOCKED: 'warning',
  VERIFIED: 'success',
  DIRECT: 'textMuted',
  AUTONOMOUS: 'accentActive',
};

export const STAGE_STATE_SYMBOLS: Record<string, string> = {
  PASS: '●', // ●
  ACTIVE: '◐', // ◐
  PENDING: '○', // ○
  FAIL: '✕', // ✕
  BLOCKED: '■', // ■
};

export const PIPELINE_STAGES: string[] = ['Analyze', 'Plan', 'Review', 'Apply'];
