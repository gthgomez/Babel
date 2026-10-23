/** Per-turn SDK subprocess handle key (thread + process generation + turn). */
export function claudeCodeSessionKey(
  threadId: string,
  processGeneration: number,
  turnId: string,
): string {
  return `${threadId}:${processGeneration}:${turnId}`;
}
