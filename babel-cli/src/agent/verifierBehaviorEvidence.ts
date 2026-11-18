/**
 * Static evidence checks for a verifier input file.
 *
 * Relevance binding must not treat a goal mentioned in a comment, an unrelated
 * arithmetic assertion, a negated assertion, a skipped registration or a
 * lexically dead falsy guard as proof. The matcher is deliberately lexical and
 * fail-closed: unsupported idioms simply stay unbound and therefore unverified.
 *
 * Dynamically dead code that a lexer cannot see (a callback that is never
 * invoked, a branch guarded by a computed false value) is a disclosed
 * limitation, not a claim that every dead path is detected.
 */

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

function closingBrace(source: string, openIndex: number): number | null {
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
    if (char === '{') depth += 1
    else if (char === '}') {
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

/**
 * Remove blocks guarded by a literal falsy condition. This is the demonstrable
 * dead-guard subset; computed false conditions stay a disclosed limitation.
 */
export function stripDeadLiteralGuards(source: string): string {
  let out = ''
  let consumed = 0
  const guard = /\b(?:if|while)\s*\(\s*(?:false|0n|-0|0|NaN|''|""|``|null|undefined|void\s+0)\s*\)/g
  for (const match of source.matchAll(guard)) {
    if (match.index! < consumed) continue
    let cursor = match.index! + match[0].length
    while (cursor < source.length && /\s/.test(source[cursor]!)) cursor += 1
    let end: number | null = null
    if (source[cursor] === '{') {
      end = closingBrace(source, cursor)
    } else {
      const semicolon = source.indexOf(';', cursor)
      end = semicolon >= 0 ? semicolon : null
    }
    if (end === null) continue
    out += source.slice(consumed, match.index!) + ' '.repeat(end - match.index! + 1)
    consumed = end + 1
  }
  return out + source.slice(consumed)
}

function executableTestSpans(code: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  for (const match of code.matchAll(/\b(?:test|it)(?:\.only)?\s*\(/g)) {
    const open = code.indexOf('(', match.index!)
    const end = open >= 0 ? closingParen(code, open) : null
    if (end !== null) spans.push({ start: match.index!, end })
  }
  return spans
}

function unquote(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length < 2) return null
  const quote = trimmed[0]!
  if (quote !== "'" && quote !== '"' && quote !== '`') return null
  if (trimmed.at(-1) !== quote) return null
  return trimmed.slice(1, -1).replace(/\\([\\'"`])/g, '$1')
}

function splitTopLevel(value: string, separator: string): string[] | null {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (depth === 0 && value.startsWith(separator, index)) {
      parts.push(value.slice(start, index))
      start = index + separator.length
      index += separator.length - 1
    }
  }
  if (quote || depth !== 0) return null
  parts.push(value.slice(start))
  return parts
}

function stripOuterParens(value: string): string {
  let current = value.trim()
  while (current.startsWith('(') && current.endsWith(')')) {
    const end = closingParen(current, 0)
    if (end !== current.length - 1) break
    current = current.slice(1, -1).trim()
  }
  return current
}

function numericExpression(value: string): number | null {
  if (!/^[\d.+\-*/ ()]+$/.test(value)) return null
  let index = 0
  const tokens = value.match(/\d+(?:\.\d+)?|[()+\-*/]/g)
  if (!tokens || tokens.join('') !== value.replace(/\s+/g, '')) return null
  const peek = () => tokens[index]
  const parseFactor = (): number | null => {
    if (peek() === '(') {
      index += 1
      const inner = parseSum()
      if (peek() !== ')') return null
      index += 1
      return inner
    }
    if (peek() === '-') {
      index += 1
      const inner = parseFactor()
      return inner === null ? null : -inner
    }
    const token = peek()
    if (token && /^\d/.test(token)) {
      index += 1
      return Number(token)
    }
    return null
  }
  const parseProduct = (): number | null => {
    let left = parseFactor()
    while (left !== null && (peek() === '*' || peek() === '/')) {
      const operator = peek()
      index += 1
      const right = parseFactor()
      if (right === null) return null
      left = operator === '*' ? left * right : left / right
    }
    return left
  }
  const parseSum = (): number | null => {
    let left = parseProduct()
    while (left !== null && (peek() === '+' || peek() === '-')) {
      const operator = peek()
      index += 1
      const right = parseProduct()
      if (right === null) return null
      left = operator === '+' ? left + right : left - right
    }
    return left
  }
  const result = parseSum()
  return result !== null && index === tokens.length ? result : null
}

/** Const-only, scoped to the current test (or file prefix for scripts). */
function localConstants(
  code: string,
  scopeStart: number,
  beforeIndex: number,
): Map<string, string> {
  const constants = new Map<string, string>()
  const scopes = scopeStart > 0
    ? [code.slice(0, scopeStart), code.slice(scopeStart, beforeIndex)]
    : [code.slice(0, beforeIndex)]
  for (const scope of scopes) {
    for (const match of scope.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
      // let/var are deliberately absent: their value can change before the
      // assertion, so resolving the declaration would certify a stale value.
      const value = evaluateOperand(match[2]!, constants)
      if (value !== null) constants.set(match[1]!, value)
    }
  }
  return constants
}

function evaluateOperand(raw: string, constants: ReadonlyMap<string, string>): string | null {
  const value = stripOuterParens(raw)
  const quoted = unquote(value)
  if (quoted !== null) return quoted
  if (/^[A-Za-z_$][\w$]*$/.test(value)) return constants.get(value) ?? null
  if (/^[-+]?\d+(?:\.\d+)?$/.test(value)) return String(Number(value))
  const parts = splitTopLevel(value, '+')
  if (parts && parts.length > 1) {
    const evaluated = parts.map(part => evaluateOperand(part, constants))
    if (evaluated.every(part => part !== null)) {
      const strings = parts.some(part => unquote(stripOuterParens(part)) !== null)
      if (strings) return evaluated.join('')
      const sum = numericExpression(value)
      if (sum !== null) return String(sum)
      if (evaluated.every(part => Number.isFinite(Number(part)))) {
        return String(evaluated.reduce((total, part) => total + Number(part), 0))
      }
    }
  }
  const numeric = numericExpression(value)
  return numeric === null ? null : String(numeric)
}

function valuesEqual(actual: string | null, expected: string): boolean {
  if (actual === null) return false
  const left = Number(actual)
  const right = Number(expected)
  if (Number.isFinite(left) && Number.isFinite(right)) return left === right
  return actual === expected
}

interface AssertionCandidate {
  index: number
  left: string
  right: string
}

function assertionCandidates(code: string): AssertionCandidate[] {
  const candidates: AssertionCandidate[] = []
  const binary = /\bassert\s*\.\s*(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(/g
  for (const match of code.matchAll(binary)) {
    const open = code.indexOf('(', match.index!)
    const end = open >= 0 ? closingParen(code, open) : null
    if (end === null) continue
    const args = splitTopLevel(code.slice(open + 1, end), ',')
    if (!args || args.length !== 2) continue
    candidates.push({ index: match.index!, left: args[0]!, right: args[1]! })
  }
  const ok = /\bassert\s*\.\s*(?:ok)?\s*\(/g
  for (const match of code.matchAll(ok)) {
    const open = code.indexOf('(', match.index!)
    const end = open >= 0 ? closingParen(code, open) : null
    if (end === null) continue
    const args = splitTopLevel(code.slice(open + 1, end), '===')
    if (!args || args.length !== 2) continue
    candidates.push({ index: match.index!, left: args[0]!, right: args[1]! })
  }
  const expected = /\bexpect\s*\(/g
  for (const match of code.matchAll(expected)) {
    const open = code.indexOf('(', match.index!)
    const end = open >= 0 ? closingParen(code, open) : null
    if (end === null) continue
    const rest = code.slice(end + 1)
    const matcher = rest.match(/^\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(/)
    if (!matcher) continue
    const valueOpen = end + 1 + matcher[0].length - 1
    const valueEnd = closingParen(code, valueOpen)
    if (valueEnd === null) continue
    const args = splitTopLevel(code.slice(valueOpen + 1, valueEnd), ',')
    if (!args || args.length !== 1) continue
    candidates.push({ index: match.index!, left: code.slice(open + 1, end), right: args[0]! })
  }
  return candidates
}

function liveNestingAllowed(prefix: string): boolean {
  let headerEnd = 0
  const arrow = prefix.indexOf('=>')
  if (arrow >= 0) {
    headerEnd = arrow + 2
  } else {
    const declared = prefix.match(/\bfunction\b[^{]*\{/)
    if (declared) headerEnd = declared.index! + declared[0].length
  }
  const body = prefix.slice(headerEnd)
  const extraArrows = (body.match(/=>/g) ?? []).length
  const extraFunctions = (body.match(/\bfunction\b/g) ?? []).length
  const sync = '(?:forEach|map|filter|some|every|reduce|flatMap|find|findIndex|reduceRight)'
  const allowed = (body.match(new RegExp('\\.\\s*' + sync + '\\s*\\(\\s*(?:function\\b[^()]*|[^()]{0,140}?=>)', 'g')) ?? []).length
  // One synchronous iteration callback is live. Deeper nesting, an unrelated
  // callback (then/finally/dead helper) or a stored un-invoked arrow is not.
  return extraArrows + extraFunctions <= allowed && extraArrows + extraFunctions <= 1
}

/**
 * The goal's expected result must be an operand of a real assertion in a live
 * test (or a top-level executable script), and a call goal must put its exact
 * call in that same assertion. File-local immutable const literals and simple
 * literal arithmetic are resolved. Comments, skipped registrations, dead
 * literal guards, name-only tests, unrelated arithmetic and negated assertions
 * are not evidence.
 */
export function assertionEvidenceMatches(
  content: string,
  callPattern: RegExp | null,
  fragment: string,
  options: { requiredSymbols?: readonly string[] } = {},
): boolean {
  if (fragment.length === 0) return false
  const code = stripDeadLiteralGuards(stripSkippedRegistrations(stripJsComments(content)))
  const spans = executableTestSpans(code)
  const hasRegistrations = spans.length > 0
  for (const candidate of assertionCandidates(code)) {
    if (hasRegistrations && !spans.some(span => candidate.index >= span.start && candidate.index <= span.end)) continue
    const span = spans.find(item => candidate.index >= item.start && candidate.index <= item.end)
    if (span && !liveNestingAllowed(code.slice(span.start, candidate.index))) continue
    const constants = localConstants(code, span ? span.start : 0, candidate.index)
    if (callPattern) {
      const leftCall = callPattern.test(candidate.left)
      const rightCall = callPattern.test(candidate.right)
      if (!leftCall && !rightCall) continue
      const expected = leftCall ? candidate.right : candidate.left
      if (valuesEqual(evaluateOperand(expected, constants), fragment)) return true
      continue
    }
    const symbols = options.requiredSymbols ?? []
    if (symbols.length === 0) continue
    const referencesSymbol = (operand: string) => symbols.some(symbol =>
      new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(operand))
    if (referencesSymbol(candidate.left) && valuesEqual(evaluateOperand(candidate.right, constants), fragment)) return true
    if (referencesSymbol(candidate.right) && valuesEqual(evaluateOperand(candidate.left, constants), fragment)) return true
  }
  return false
}
