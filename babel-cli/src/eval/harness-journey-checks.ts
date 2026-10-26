/** Pure grading helpers over host-captured data; never opens candidate paths. */
import { createHash } from 'node:crypto'
import { isCredentialTargetPath } from '../authority/protectedPath.js'

export const outputDigest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
export const assessmentDigest = (answer: string, artifactHash?: string): string => outputDigest(artifactHash ? `${answer}\u0000${artifactHash}` : answer)
export interface CapturedJourneyOutput { bytes: Buffer; evidenceRef: string }
export type JourneyOutputReader = (relativePath: string) => Promise<CapturedJourneyOutput>

/** Reader must use already captured immutable host data, not arbitrary live paths. */
export async function capturedBytes(read: JourneyOutputReader, path: string): Promise<{ bytes: Buffer; hash: string; evidenceRef: string } | null> {
  if (!path || path.startsWith('/') || /[:\\\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || isCredentialTargetPath(path)) return null
  try {
    const output = await read(path)
    if (!Buffer.isBuffer(output.bytes) || output.bytes.length > 1_048_576 || !output.evidenceRef) return null
    return { bytes: Buffer.from(output.bytes), hash: outputDigest(output.bytes), evidenceRef: output.evidenceRef }
  } catch { return null }
}

export async function capturedText(read: JourneyOutputReader, path: string): Promise<{ text: string; hash: string; evidenceRef: string } | null> {
  const output = await capturedBytes(read, path)
  if (!output) return null
  const text = output.bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(output.bytes)) return null
  return { text, hash: output.hash, evidenceRef: output.evidenceRef }
}

/** Strict RFC-style quoted fields, CRLF/LF, escaped quotes; malformed CSV fails. */
export function parseJourneyCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let closedQuote = false
  function endField(): void { row.push(field); field = ''; closedQuote = false }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (char === '"') { quoted = false; closedQuote = true }
      else field += char
    } else if (char === '"' && !field && !closedQuote) quoted = true
    else if (char === ',') endField()
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      endField(); rows.push(row); row = []
    } else {
      if (closedQuote || char === '"') throw new Error('Malformed CSV field')
      field += char
    }
  }
  if (quoted) throw new Error('Unterminated CSV quote')
  if (field || row.length || closedQuote) { endField(); rows.push(row) }
  return rows
}

export function accurateRevenueCsv(text: string): boolean {
  try {
    const [header, ...rows] = parseJourneyCsv(text)
    if (JSON.stringify(header) !== JSON.stringify(['product', 'gross', 'refunds', 'net']) || rows.length !== 2) return false
    const expected: Record<string, number[]> = { A: [150, 20, 130], B: [80, 10, 70] }
    const seen = new Set<string>()
    for (const [product, ...values] of rows) {
      if (!product || !expected[product] || seen.has(product) || values.length !== 3) return false
      if (!values.every((value, i) => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) === expected[product]![i])) return false
      seen.add(product)
    }
    return true
  } catch { return false }
}
