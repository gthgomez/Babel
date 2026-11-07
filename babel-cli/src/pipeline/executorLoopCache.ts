/** Bounded eviction for the executor's per-turn file-read cache. */
export function evictFileReadCache(
  turn: number,
  fileReadCache: Map<string, string>,
  fileReadCacheUsedTurn: Map<string, number>,
  fileReadCacheTotalBytes: number,
  maxBytes: number,
): { fileReadCacheTotalBytes: number } {
  // Evict stale entries (stale if turn - lastUsed > 5)
  const toEvict: string[] = [];
  for (const [filePath, lastUsed] of fileReadCacheUsedTurn.entries()) {
    if (turn - lastUsed > 5) {
      toEvict.push(filePath);
    }
  }
  for (const filePath of toEvict) {
    const evictedSize = Buffer.byteLength(fileReadCache.get(filePath) ?? '', 'utf8');
    fileReadCacheTotalBytes -= evictedSize;
    fileReadCache.delete(filePath);
    fileReadCacheUsedTurn.delete(filePath);
  }

  // Size-bounded LRU eviction: after turn-based eviction, if the cache still
  // exceeds the byte budget, evict oldest entries first.
  if (fileReadCacheTotalBytes > maxBytes) {
    const sortedByAge = [...fileReadCacheUsedTurn.entries()].sort((a, b) => a[1] - b[1]);
    for (const [filePath] of sortedByAge) {
      if (fileReadCacheTotalBytes <= maxBytes) break;
      const evictedSize = Buffer.byteLength(fileReadCache.get(filePath) ?? '', 'utf8');
      fileReadCacheTotalBytes -= evictedSize;
      fileReadCache.delete(filePath);
      fileReadCacheUsedTurn.delete(filePath);
    }
  }

  return { fileReadCacheTotalBytes };
}
