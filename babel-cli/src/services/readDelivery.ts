/** Host-origin facts about the content actually delivered by a file read. */
export interface ReadDeliveryWindow {
  startLine: number
  endLine: number
  totalLines: number
  completeFile: boolean
  byteTruncated: boolean
}

/** Validate delivery facts without interpreting display headers as authority. */
export function isReadDeliveryWindow(value: unknown): value is ReadDeliveryWindow {
  if (!value || typeof value !== 'object') return false
  const w = value as ReadDeliveryWindow
  if (![w.startLine, w.endLine, w.totalLines].every(Number.isSafeInteger) ||
      w.startLine < 1 || w.endLine < 0 || w.totalLines < 0 || w.endLine > w.totalLines ||
      typeof w.completeFile !== 'boolean' || typeof w.byteTruncated !== 'boolean') return false
  const empty = w.totalLines === 0 && w.startLine === 1 && w.endLine === 0
  if (!empty && w.endLine < w.startLine) return false
  return !w.completeFile || (!w.byteTruncated && w.startLine === 1 && w.endLine === w.totalLines)
}

export interface ReadByteCompleteness {
  complete: boolean
  original_bytes: number
  returned_bytes: number
  reason?: 'byte_limit'
}

export interface FormattedFileRead {
  exit_code: number
  stdout: string
  stderr: string
  read_window?: ReadDeliveryWindow
  output_completeness: ReadByteCompleteness
}

function fileLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Format actual delivered content; byte completeness and line coverage differ. */
export function formatFileReadContent(content: string, options?: { offset?: number; limit?: number; raw?: boolean }): FormattedFileRead {
  const maxBytes = 100 * 1024
  const originalBytes = Buffer.byteLength(content, 'utf8')
  const totalLines = fileLines(content).length
  const capped = originalBytes > maxBytes
  let delivered = content
  if (capped) {
    const bytes = Buffer.from(content, 'utf8')
    let end = maxBytes
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
    delivered = bytes.subarray(0, end).toString('utf8')
    const newline = delivered.lastIndexOf('\n')
    if (newline > 0) delivered = delivered.substring(0, newline)
  }
  const completeness: ReadByteCompleteness = { complete: !capped, original_bytes: originalBytes,
    returned_bytes: Buffer.byteLength(delivered, 'utf8'), ...(capped ? { reason: 'byte_limit' as const } : {}) }
  const lines = fileLines(delivered)
  if (options?.raw) return { exit_code: 0, stdout: delivered, stderr: '', output_completeness: completeness,
    read_window: { startLine: 1, endLine: lines.length, totalLines, completeFile: !capped, byteTruncated: capped } }
  const start = options?.offset ?? 1
  const limit = options?.limit ?? 200
  const index = Math.max(0, Math.min(start - 1, lines.length))
  const selected = lines.slice(index, index + limit)
  const endLine = index + selected.length
  if (selected.length === 0) return { exit_code: 0, stderr: '', output_completeness: completeness,
    stdout: totalLines === 0 ? '' : `[File has ${totalLines} lines; lines ${start}–${start + limit - 1} are out of range]`,
    ...(totalLines === 0 ? { read_window: { startLine: 1, endLine: 0, totalLines: 0, completeFile: true, byteTruncated: false } } : {}) }
  const numbered = selected.map((line, i) => `${String(index + i + 1).padStart(String(endLine).length)}│${line}`)
  const capMessage = capped ? ` [truncated at ${maxBytes / 1024} KB]` : ''
  const header = endLine < totalLines || start > 1 || capped
    ? [`[Showing lines ${start}-${endLine} of ${totalLines}${capMessage} — use offset/limit to see more]`] : []
  return { exit_code: 0, stdout: [...header, ...numbered].join('\n'), stderr: '', output_completeness: completeness,
    read_window: { startLine: index + 1, endLine, totalLines, completeFile: !capped && index === 0 && endLine === totalLines, byteTruncated: capped } }
}
