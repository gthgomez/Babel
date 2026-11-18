/**
 * Static evidence checks for a verifier input file.
 *
 * Relevance binding must not treat a goal mentioned in a comment, an unrelated
 * arithmetic assertion, a negated assertion or a skipped registration as proof.
 * These helpers keep that decision lexical and fail-closed: unsupported test
 * styles simply stay unbound and therefore unverified.
 */

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

function escapeRegex(value: string): string {
  return value.replace(REGEX_SPECIALS, '\\$&')
}

/** Replace comments with spaces without touching string/template contents. */
export function stripJsComments(source: string): string {
  let out = ''
  let quote = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    const next = source[index + 1]
    if (quote) {
      out += char
      if (char === '\\') {
        if (next !== undefined) {
          out += next
          index += 1
        }
        continue
      }
      if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out += ' '
        index += 1
      }
      if (index < source.length) out += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      out += '  '
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        out += source[index] === '\n' ? '\n' : ' '
        index += 1
      }
      if (index < source.length) {
        out += '  '
        index += 1
      }
      continue
    }
    out += char
  }
  return out
}

function closingParen(source: string, openIndex: number): number | null {
  let depth = 0
  let quote = ''
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]!
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return null
}

/** Remove skipped/todo test registrations so their assertions never bind evidence. */
export function stripSkippedRegistrations(source: string): string {
  const registration =
    /\b(?:test|it|describe|suite)(?:\.(?:skip|todo|only))?\s*\(|\b(?:xit|xdescribe|xtest)\s*\(/g
  let out = ''
  let consumed = 0
  for (const match of source.matchAll(registration)) {
    if (match.index! < consumed) continue
    const open = source.indexOf('(', match.index!)
    const end = open >= 0 ? closingParen(source, open) : null
    if (open < 0 || end === null) continue
    const header = source.slice(match.index!, open)
    const args = source.slice(open + 1, end)
    const skipped = /\.(?:skip|todo)\b/.test(header) ||
      /^x(?:it|describe|test)\b/.test(match[0]) ||
      /\bskip\s*:\s*true\b/.test(args.slice(0, 240))
    if (!skipped) continue
    out += source.slice(consumed, match.index!) + ' '.repeat(end - match.index! + 1)
    consumed = end + 1
  }
  return out + source.slice(consumed)
}

function assertionValuePattern(fragment: string): string {
  const escaped = escapeRegex(fragment)
  const wordBounded = /^[A-Za-z0-9_.]/.test(fragment) && /[A-Za-z0-9_.]$/.test(fragment)
  const bare = wordBounded ? `(?<![\\w.])${escaped}(?![\\w.])` : escaped
  return `(?:["'\`]${escaped}["'\`]|${bare})`
}

/**
 * The goal's call and expected result must co-occur inside one real assertion.
 * Comments, unrelated arithmetic, negated assertions and skipped registrations
 * cannot supply verifier relevance.
 */
function executableTestSpans(code: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  for (const match of code.matchAll(/\b(?:test|it)(?:\.only)?\s*\(/g)) {
    const open = code.indexOf('(', match.index!)
    const end = open >= 0 ? closingParen(code, open) : null
    if (end !== null) spans.push({ start: match.index!, end })
  }
  return spans
}

export function assertionEvidenceMatches(
  content: string,
  callPattern: RegExp,
  fragment: string,
): boolean {
  if (fragment.length === 0) return false
  const code = stripSkippedRegistrations(stripJsComments(content))
  const spans = executableTestSpans(code)
  const call = callPattern.source
  const value = assertionValuePattern(fragment)
  const patterns = [
    new RegExp(`assert\\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\\s*\\(\\s*${call}\\s*,\\s*${value}\\s*\\)`),
    new RegExp(`assert\\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\\s*\\(\\s*${value}\\s*,\\s*${call}\\s*\\)`),
    new RegExp(`assert\\.(?:ok)?\\s*\\(\\s*${call}\\s*===\\s*${value}\\s*\\)`),
    new RegExp(`assert\\.(?:ok)?\\s*\\(\\s*${value}\\s*===\\s*${call}\\s*\\)`),
    new RegExp(`expect\\s*\\(\\s*${call}\\s*\\)\\s*\\.\\s*(?:toBe|toEqual|toStrictEqual)\\s*\\(\\s*${value}\\s*\\)`),
  ]
  const hasRegistrations = /\b(?:test|it)(?:\.only)?\s*\(/.test(code)
  return patterns.some(pattern => {
    const match = pattern.exec(code)
    if (!match || match.index === undefined) return false
    if (!hasRegistrations) return true
    return spans.some(span => match.index! >= span.start && match.index! <= span.end)
  })
}
