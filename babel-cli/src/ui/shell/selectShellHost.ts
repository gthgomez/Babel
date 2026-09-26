import { isA11yMode } from '../a11y.js'

export type ShellHostKind = 'legacy' | 'north_star'

export interface ShellHostSelectionInput {
  isTTY?: boolean
  isCi?: boolean
  isHeadless?: boolean
  term?: string
  cursorAddressing?: boolean
  a11y?: boolean
  ui4Qualified?: boolean
  optIn?: string | undefined
}

/** Collect ambient process/terminal facts once at the runtime boundary. */
export function collectShellHostFacts(): ShellHostSelectionInput {
  const term = (process.env['TERM'] ?? '').toLowerCase()
  return {
    isTTY: Boolean(process.stdout.isTTY),
    isCi: Boolean(process.env['CI']),
    isHeadless: process.env['BABEL_HEADLESS'] === '1',
    term,
    a11y: isA11yMode(),
    optIn: process.env['BABEL_TUI_SHELL'],
    // Cursor-shape support is unrelated to cursor addressing. The shell's
    // output contract only requires ordinary CUP-style addressing, which is
    // available on a real non-dumb TTY; unknown/non-TTY cases fail closed.
    cursorAddressing: Boolean(process.stdout.isTTY) && term !== 'dumb',
  }
}
export interface ShellHostSelection {
  host: ShellHostKind
  reason:
    | 'legacy-default'
    | 'explicit-opt-out'
    | 'non-tty'
    | 'ci'
    | 'headless'
    | 'a11y'
    | 'dumb-terminal'
    | 'unsupported-cursor-addressing'
    | 'developer-opt-in'
    | 'qualified-default'
}

/**
 * Decide whether the interactive session can use the North Star host.
 *
 * The decision is deliberately pure so NO_COLOR and terminal styling cannot
 * change model preparation, policy, or any other runtime behavior.
 */
export function selectShellHost(input?: ShellHostSelectionInput): ShellHostSelection {
  const facts = input ?? collectShellHostFacts()
  const isTTY = facts.isTTY ?? false
  const isCi = facts.isCi ?? false
  const isHeadless = facts.isHeadless ?? false
  const term = (facts.term ?? '').toLowerCase()
  const a11y = facts.a11y ?? false
  const optIn = facts.optIn
  const cursorAddressing = facts.cursorAddressing ?? false

  if (optIn === '0' || optIn === 'false') return { host: 'legacy', reason: 'explicit-opt-out' }
  if (!isTTY) return { host: 'legacy', reason: 'non-tty' }
  if (isCi) return { host: 'legacy', reason: 'ci' }
  if (isHeadless) return { host: 'legacy', reason: 'headless' }
  if (a11y) return { host: 'legacy', reason: 'a11y' }
  if (term === 'dumb') return { host: 'legacy', reason: 'dumb-terminal' }
  if (!cursorAddressing) return { host: 'legacy', reason: 'unsupported-cursor-addressing' }
  if (optIn === '1' || optIn === 'true') return { host: 'north_star', reason: 'developer-opt-in' }
  if (facts.ui4Qualified === true) return { host: 'north_star', reason: 'qualified-default' }
  return { host: 'legacy', reason: 'legacy-default' }
}
