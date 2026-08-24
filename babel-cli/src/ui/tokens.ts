export interface ThemeDefinition {
  name: string;
  mode: 'dark' | 'light';
  trueColor: Record<string, string>;
  ansiFallback: Record<string, number>;
}

/** Extra presentation roles derived from core palette entries. */
function presentationTrueColor(core: Record<string, string>): Record<string, string> {
  return {
    syntaxKeyword: core['accent'] ?? '',
    syntaxType: core['info'] ?? '',
    syntaxString: core['accentStrong'] ?? '',
    syntaxNumber: core['warning'] ?? '',
    syntaxComment: core['textGhost'] ?? '',
    syntaxFunction: core['textPrimary'] ?? '',
    identityPrimary: core['accent'] ?? '',
    identitySecondary: core['accentSecondary'] ?? '',
    activityTool: core['info'] ?? '',
    activityModel: core['accentSecondary'] ?? '',
  };
}

function presentationFallback(core: Record<string, number>): Record<string, number> {
  return {
    syntaxKeyword: core['accent'] ?? 183,
    syntaxType: core['info'] ?? 117,
    syntaxString: core['accentStrong'] ?? 134,
    syntaxNumber: core['warning'] ?? 221,
    syntaxComment: core['textGhost'] ?? 60,
    syntaxFunction: core['textPrimary'] ?? 255,
    identityPrimary: core['accent'] ?? 183,
    identitySecondary: core['accentSecondary'] ?? 147,
    activityTool: core['info'] ?? 117,
    activityModel: core['accentSecondary'] ?? 147,
  };
}

function defineTheme(
  name: string,
  mode: 'dark' | 'light',
  trueColor: Record<string, string>,
  ansiFallback: Record<string, number>,
): ThemeDefinition {
  return {
    name,
    mode,
    trueColor: { ...trueColor, ...presentationTrueColor(trueColor) },
    ansiFallback: { ...ansiFallback, ...presentationFallback(ansiFallback) },
  };
}

export const babelDusk: ThemeDefinition = defineTheme(
  'babel-dusk',
  'dark',
  {
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
  {
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
);

export const babelDawn: ThemeDefinition = defineTheme(
  'babel-dawn',
  'light',
  {
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
  {
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
);

export const babelDuskDaltonized: ThemeDefinition = defineTheme(
  'babel-dusk-daltonized',
  'dark',
  {
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
    success: '#87AFFF',
    warning: '#FFD75F',
    error: '#FF875F',
  },
  {
    textPrimary: 255,
    textMuted: 146,
    textGhost: 60,
    border: 60,
    accent: 183,
    accentSecondary: 147,
    accentActive: 141,
    accentStrong: 134,
    info: 117,
    success: 111,
    warning: 221,
    error: 209,
  },
);

export const babelDawnDaltonized: ThemeDefinition = defineTheme(
  'babel-dawn-daltonized',
  'light',
  {
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
    success: '#3F7FCF',
    warning: '#AF8F2F',
    error: '#BF6F3F',
  },
  {
    textPrimary: 0,
    textMuted: 8,
    textGhost: 7,
    border: 7,
    accent: 5,
    accentSecondary: 4,
    accentActive: 5,
    accentStrong: 5,
    info: 6,
    success: 12,
    warning: 3,
    error: 9,
  },
);

/**
 * High-contrast dark theme. Meets WCAG AA 4.5:1 minimum contrast ratio
 * on dark backgrounds. Uses pure white text on near-black for maximum
 * legibility. Accent colors are selected for ≥7:1 contrast (AAA level).
 */
export const babelHc: ThemeDefinition = defineTheme(
  'babel-hc',
  'dark',
  {
    background: '#0A0A0A',
    panel: '#141414',
    panelRaised: '#1E1E1E',
    border: '#C0C0C0',
    textPrimary: '#FFFFFF',
    textMuted: '#D0D0D0',
    textGhost: '#A0A0A0',
    accent: '#87CEFF',
    accentSecondary: '#B0B0FF',
    accentActive: '#9FC5FF',
    accentStrong: '#FFB0D0',
    info: '#87D7FF',
    success: '#7FFF7F',
    warning: '#FFFF60',
    error: '#FF7070',
  },
  {
    textPrimary: 15,
    textMuted: 7,
    textGhost: 8,
    border: 7,
    accent: 12,
    accentSecondary: 13,
    accentActive: 12,
    accentStrong: 13,
    info: 14,
    success: 10,
    warning: 11,
    error: 9,
  },
);

/**
 * Opt-in cool slate / periwinkle candidate. Not the default.
 * Hue choices here are theme-local, not architecture-wide invariants.
 */
export const babelPrismNight: ThemeDefinition = defineTheme(
  'babel-prism-night',
  'dark',
  {
    background: '#0B0D12',
    panel: '#12151D',
    panelRaised: '#191D28',
    border: '#303747',
    textPrimary: '#E6EAF2',
    textMuted: '#7D899F',
    textGhost: '#626C7D',
    accent: '#7C8CFF',
    accentSecondary: '#A78BFA',
    accentActive: '#7C8CFF',
    accentStrong: '#7C8CFF',
    info: '#55C2E6',
    success: '#58C99B',
    warning: '#E8B55B',
    error: '#ED6A72',
  },
  {
    textPrimary: 255,
    textMuted: 246,
    textGhost: 243,
    border: 239,
    accent: 69,
    accentSecondary: 141,
    accentActive: 69,
    accentStrong: 69,
    info: 80,
    success: 78,
    warning: 179,
    error: 168,
  },
);

export const BUILTIN_THEMES: Record<string, ThemeDefinition> = {
  [babelDusk.name]: babelDusk,
  [babelDawn.name]: babelDawn,
  [babelDuskDaltonized.name]: babelDuskDaltonized,
  [babelDawnDaltonized.name]: babelDawnDaltonized,
  [babelHc.name]: babelHc,
  [babelPrismNight.name]: babelPrismNight,
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
  accentGold: activeTheme.trueColor.accentStrong,
  accentGoldBright: activeTheme.trueColor.accent,
  accentBlue: activeTheme.trueColor.info,
};

export const FALLBACK_FG: Record<string, number | undefined> = {
  ...activeTheme.ansiFallback,
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
  PASS: '●',
  ACTIVE: '◐',
  PENDING: '○',
  FAIL: '✕',
  BLOCKED: '■',
};

export const PIPELINE_STAGES: string[] = ['Analyze', 'Plan', 'Review', 'Apply'];
