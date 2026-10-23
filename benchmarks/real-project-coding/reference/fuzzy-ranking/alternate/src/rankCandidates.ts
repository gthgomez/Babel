import { fuzzyScore } from './fuzzy.ts';

type RankedCandidate = { item: string; score: number; index: number };

export function rankCandidates(
  query: string,
  candidates: readonly string[],
  options?: { limit?: number; minScore?: number },
): RankedCandidate[] {
  const maximum = options?.limit;
  const threshold = options?.minScore === undefined ? 0 : options.minScore;
  if (maximum !== undefined) {
    if (typeof maximum !== 'number' || !Number.isFinite(maximum) || maximum < 0 || Math.floor(maximum) !== maximum) {
      throw new RangeError('invalid limit');
    }
  }
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0) {
    throw new RangeError('invalid minScore');
  }

  const result: RankedCandidate[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const item = candidates[index];
    const score = fuzzyScore(query, item);
    if ((query !== '' && score <= 0) || score < threshold) continue;
    let position = result.length;
    while (position > 0 && result[position - 1].score < score) position--;
    result.splice(position, 0, { item, score, index });
  }
  if (maximum !== undefined && result.length > maximum) result.length = maximum;
  return result;
}
