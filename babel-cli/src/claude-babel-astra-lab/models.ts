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
