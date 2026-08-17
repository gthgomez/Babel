/**
 * Compact repository navigation helpers. Model-facing surface stays
 * read / search / navigate / git — no extra tool names.
 */

export interface SearchHitView {
  file: string
  line: number
  match: string
  contextBefore?: string[]
  contextAfter?: string[]
}

/**
 * Format search hits with file, line, match, nearby context, and truncation.
 */
export function formatSearchHits(
  hits: SearchHitView[],
  opts?: { truncated?: boolean; total?: number; contextLines?: number },
): string {
  if (hits.length === 0) return 'No matches found.'
  const lines: string[] = []
  for (const hit of hits) {
    lines.push(`${hit.file}:${hit.line}: ${hit.match}`)
    const before = hit.contextBefore ?? []
    const after = hit.contextAfter ?? []
    for (const c of before) lines.push(`  - ${c}`)
    for (const c of after) lines.push(`  + ${c}`)
  }
  const total = opts?.total ?? hits.length
  if (opts?.truncated || total > hits.length) {
    lines.push(`...[${hits.length} shown of ${total}; refine the pattern or path]`)
  } else {
    lines.push(`[${hits.length} match(es)]`)
  }
  return lines.join('\n')
}

export interface RepoMapInput {
  topDirs: string[]
  keyFiles: string[]
  testHints?: string[]
  entrypoints?: string[]
  symbols?: string[]
}

/**
 * Bounded structural map (no embeddings).
 */
export function buildBoundedRepoMap(input: RepoMapInput): string {
  const lines = ['## Repository Map']
  if (input.topDirs.length > 0) {
    lines.push(`dirs: ${input.topDirs.slice(0, 24).join(', ')}`)
  }
  if (input.keyFiles.length > 0) {
    lines.push(`config: ${input.keyFiles.slice(0, 16).join(', ')}`)
  }
  if (input.entrypoints && input.entrypoints.length > 0) {
    lines.push(`entrypoints: ${input.entrypoints.slice(0, 8).join(', ')}`)
  }
  if (input.testHints && input.testHints.length > 0) {
    lines.push(`tests: ${input.testHints.slice(0, 8).join(', ')}`)
  }
  if (input.symbols && input.symbols.length > 0) {
    lines.push(`symbols: ${input.symbols.slice(0, 12).join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * Attach ±N context lines around a match from a file's line array.
 */
export function attachMatchContext(
  lines: string[],
  matchLine: number,
  contextLines = 2,
): { contextBefore: string[]; contextAfter: string[] } {
  const idx = Math.max(0, matchLine - 1)
  const before: string[] = []
  const after: string[] = []
  for (let i = Math.max(0, idx - contextLines); i < idx; i++) {
    before.push(`${i + 1}:${lines[i] ?? ''}`)
  }
  for (let i = idx + 1; i <= idx + contextLines && i < lines.length; i++) {
    after.push(`${i + 1}:${lines[i] ?? ''}`)
  }
  return { contextBefore: before, contextAfter: after }
}
