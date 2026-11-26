/** A single required numeric observation of a named function, not a general rule. */
export interface TaskBehaviorPoint {
  symbol: string
  args: number[]
  expected: number
}

const NUMBER = String.raw`-?(?:0|[1-9]\d*)(?:\.\d+)?`
const SYMBOL = String.raw`[A-Za-z_$][\w$]*`
const DECLARATIVE = /^(?:we|i) need /i
const POINT_FRAME = String.raw`(?:fix|repair|change|update|make|ensure|(?:we|i) need)\s+`
const PROSE_POINT = new RegExp(
  '^' + POINT_FRAME + String.raw`(?:the\s+)?(?<quote>\x60?)(?<symbol>${SYMBOL})\k<quote>(?:\s+function)?` +
  String.raw`\s+(?:so\s+it\s+returns|to\s+return|returns)\s+(?<expected>${NUMBER})` +
  String.raw`\s+(?:for\s+(?:a|an)\s+[\w-]+\s+of|when\s+(?:the\s+)?[\w-]+\s+is)\s+(?<input>${NUMBER})[.!]?$`,
  'i',
)
const CALL_POINT = new RegExp(
  '^' + POINT_FRAME + String.raw`(?<quote>\x60?)(?<symbol>${SYMBOL})` +
  String.raw`\(\s*(?<input>${NUMBER}(?:\s*,\s*${NUMBER})*)\s*\)\k<quote>` +
  String.raw`\s+(?:to\s+return|returns|equals)\s+(?<expected>${NUMBER})[.!]?$`,
  'i',
)

/** Parse a complete point statement. Trailing domain, conditions or examples stay unbound. */
export function taskBehaviorPoint(text: string): TaskBehaviorPoint | undefined {
  const normalized = text.trim().replace(/^please\s+/i, '')
  const point = (PROSE_POINT.exec(normalized) ?? CALL_POINT.exec(normalized))?.groups
  if (!point) return undefined
  const args = point.input!.split(',').map(Number)
  const expected = Number(point.expected)
  if (![...args, expected].every(Number.isFinite)) return undefined
  return { symbol: point.symbol!, args, expected }
}

/** An optional terminal instruction to implement the already stated point adds no obligation. */
export function withoutPointImplementationFraming(text: string): string {
  const suffix = /\.\s+(?:please\s+)?implement this change[.!]?$/i.exec(text)
  if (!suffix) return text
  const goal = text.slice(0, suffix.index + 1)
  return taskBehaviorPoint(goal) ? goal : text
}

/** A concrete desired code behavior can express an edit without an imperative verb. */
export function isDeclarativeBehaviorPoint(text: string): boolean {
  return DECLARATIVE.test(text.trim()) && !!taskBehaviorPoint(withoutPointImplementationFraming(text.trim()))
}
