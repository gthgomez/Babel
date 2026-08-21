export interface DiagnosticEvent {
  kind: string
  observation?: string
  stderr?: string
  stdout?: string
  exitCode?: number
}

/**
 * True when an investigation event occurs after a red verifier and before the next mutation.
 */
export function hadRepairEvidenceBeforeSecondMutation(events: DiagnosticEvent[]): boolean | null {
  const mutations = events
    .map((e, i) => ({ e, i }))
    .filter((x) => x.e.kind === 'mutation')
  const red = events.findIndex((e) => e.kind === 'verifier' && (e.exitCode ?? 0) !== 0)
  if (red < 0 || mutations.length < 2) return null
  const firstMut = mutations[0]!.i
  const secondMut = events.findIndex((e, i) => e.kind === 'mutation' && i > Math.max(firstMut, red))
  if (secondMut < 0) return null
  const window = events.slice(red + 1, secondMut)
  return window.some((e) =>
    ['read', 'read_range', 'search', 'lsp', 'git', 'hypothesis'].includes(e.kind),
  )
}
