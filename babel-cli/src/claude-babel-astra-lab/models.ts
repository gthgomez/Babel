export const OPENCODE_GO_MODELS = [
  'mimo-v2.5',
  'longcat-2.0',
  'deepseek-v4-flash',
] as const;

export type OpenCodeGoModel = (typeof OPENCODE_GO_MODELS)[number];

export type BenchmarkProfile =
  | 'benchmark-mimo'
  | 'benchmark-longcat'
  | 'benchmark-deepseek';

export const BENCHMARK_PROFILES: Readonly<Record<BenchmarkProfile, OpenCodeGoModel>> = Object.freeze({
  'benchmark-mimo': 'mimo-v2.5',
  'benchmark-longcat': 'longcat-2.0',
  'benchmark-deepseek': 'deepseek-v4-flash',
});

export const CLAUDE_DAILY_MODEL_MAPPING = Object.freeze({
  opus: 'deepseek-v4-flash',
  sonnet: 'longcat-2.0',
  haiku: 'mimo-v2.5',
} as const);

export function isOpenCodeGoModel(value: string): value is OpenCodeGoModel {
  return (OPENCODE_GO_MODELS as readonly string[]).includes(value);
}

export function modelForBenchmarkProfile(profile: BenchmarkProfile): OpenCodeGoModel {
  return BENCHMARK_PROFILES[profile];
}

/**
 * Historical benchmark identities retained as explicit migration aliases.
 *
 * Earlier benchmark/qualification artifacts name these IDs. They stay pinned to
 * a current exact model here so an old artifact is never silently retargeted,
 * and no current model is quietly renamed onto a historical label. A null
 * result (see {@link resolveHistoricalBenchmarkModel}) means "not a known
 * historical alias", never a guessed successor.
 */
export const HISTORICAL_BENCHMARK_MODEL_ALIASES = Object.freeze({
  'claude-3-opus': 'deepseek-v4-flash',
  'claude-3-5-sonnet': 'longcat-2.0',
  'claude-3-5-haiku': 'mimo-v2.5',
} as const);

export type HistoricalBenchmarkModelAlias = keyof typeof HISTORICAL_BENCHMARK_MODEL_ALIASES;

/**
 * Resolve a historical benchmark model ID to its pinned exact successor.
 *
 * Returns `null` for an unknown ID; the caller decides how to record the
 * legacy/unverified fact rather than receiving a fabricated route.
 */
export function resolveHistoricalBenchmarkModel(alias: string): OpenCodeGoModel | null {
  if (!isHistoricalBenchmarkModel(alias)) return null;
  return HISTORICAL_BENCHMARK_MODEL_ALIASES[alias];
}

/** True when a value is one of the explicit historical benchmark aliases. */
export function isHistoricalBenchmarkModel(value: string): value is HistoricalBenchmarkModelAlias {
  return Object.prototype.hasOwnProperty.call(HISTORICAL_BENCHMARK_MODEL_ALIASES, value);
}
