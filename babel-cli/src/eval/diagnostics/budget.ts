export function budgetExhausted(kinds: string[], notes: string[]): boolean {
  if (kinds.includes('budget_snapshot') && notes.some((n) => /budget_exceeded/i.test(n))) {
    return true
  }
  return notes.some((n) => /status_class=BUDGET_EXCEEDED/i.test(n))
}
