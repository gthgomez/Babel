/** A single required numeric observation of a named function, not a general rule. */
export interface TaskBehaviorPoint {
  symbol: string
  args: number[]
  expected: number
}

const NUMBER = String.raw`-?(?:0|[1-9]\d*)(?:\.\d+)?`
const SYMBOL = String.raw`([A-Za-z_$][\w$]*)`
const DECLARATIVE = /^(?:we|i) need /i
const POINT_FRAME = String.raw`(?:fix|repair|change|update|make|ensure|(?:we|i) need)\s+`
const PROSE_POINT = new RegExp(
  '^' + POINT_FRAME + '`?' + SYMBOL + '`?' +
  String.raw`\s+(?:so\s+it\s+returns|to\s+return|returns)\s+(${NUMBER})\s+for\s+(?:a|an)\s+[\w-]+\s+of\s+(${NUMBER})[.!]?$`,
  'i',
)
const CALL_POINT = new RegExp(
  '^' + POINT_FRAME + '`?' + SYMBOL +
  String.raw`\(\s*(${NUMBER}(?:\s*,\s*${NUMBER})*)\s*\)` + '`?' +
  String.raw`\s+(?:to\s+return|returns|equals)\s+(${NUMBER})[.!]?$`,
  'i',
)

/** Parse a complete point statement. Trailing domain, conditions or examples stay unbound. */
export function taskBehaviorPoint(text: string): TaskBehaviorPoint | undefined {
  const normalized = text.trim().replace(/^please\s+/i, '')
  const prose = PROSE_POINT.exec(normalized)
  const call = prose ? null : CALL_POINT.exec(normalized)
  if (!prose && !call) return undefined
  const symbol = (prose ?? call)![1]!
  const args = prose ? [Number(prose[3])] : call![2]!.split(',').map(Number)
  const expected = Number(prose?.[2] ?? call![3])
  if (![...args, expected].every(Number.isFinite)) return undefined
  return { symbol, args, expected }
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
