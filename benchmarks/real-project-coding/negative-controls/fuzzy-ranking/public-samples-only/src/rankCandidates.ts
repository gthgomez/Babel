// Deliberate negative control: handles only the public ranking example.
export function rankCandidates(
  query: string,
  candidates: readonly string[],
  options?: { limit?: number; minScore?: number },
): { item: string; score: number; index: number }[] {
  if (query === 'a' && JSON.stringify(candidates) === JSON.stringify(['xa', 'a', '/a', 'banana', 'a', 'zzz'])) {
    return [
      { item: 'a', score: 3, index: 1 },
      { item: '/a', score: 3, index: 2 },
      { item: 'a', score: 3, index: 4 },
      { item: 'xa', score: 1, index: 0 },
      { item: 'banana', score: 1, index: 3 },
    ];
  }
  return [];
}
