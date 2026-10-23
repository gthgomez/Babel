import { fuzzyScore } from './fuzzy.ts';

export function rankCandidates(
  query: string,
  candidates: readonly string[],
  options?: { limit?: number; minScore?: number },
): { item: string; score: number; index: number }[] {
  const limit = options?.limit;
  const minScore = options?.minScore === undefined ? 0 : options.minScore;
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0)) {
    throw new RangeError('limit must be a finite nonnegative integer');
  }
  if (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < 0) {
    throw new RangeError('minScore must be a finite nonnegative number');
  }

  const ranked = candidates.map((item, index) => ({ item, score: fuzzyScore(query, item), index }))
    .filter((row) => (query === '' || row.score > 0) && row.score >= minScore);
  ranked.sort((left, right) => right.score - left.score || left.item.localeCompare(right.item));
  const seen = new Set<string>();
  const distinct = ranked.filter((row) => { if (seen.has(row.item)) return false; seen.add(row.item); return true; });
  return limit === undefined ? distinct : distinct.slice(0, limit);
}
