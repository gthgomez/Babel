import { isA11yMode } from '../a11y.js'
import { probeTerminalCapabilities } from '../terminalProbe.js'

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
export function selectShellHost(input: ShellHostSelectionInput = {}): ShellHostSelection {
  const isTTY = input.isTTY ?? Boolean(process.stdout.isTTY)
  const isCi = input.isCi ?? Boolean(process.env['CI'])
  const isHeadless = input.isHeadless ?? process.env['BABEL_HEADLESS'] === '1'
  const term = (input.term ?? process.env['TERM'] ?? '').toLowerCase()
  const a11y = input.a11y ?? isA11yMode()
  const optIn = input.optIn ?? process.env['BABEL_TUI_SHELL']
  const cursorAddressing = input.cursorAddressing ?? probeTerminalCapabilities().cursorShape

  if (optIn === '0' || optIn === 'false') return { host: 'legacy', reason: 'explicit-opt-out' }
  if (!isTTY) return { host: 'legacy', reason: 'non-tty' }
  if (isCi) return { host: 'legacy', reason: 'ci' }
  if (isHeadless) return { host: 'legacy', reason: 'headless' }
  if (a11y) return { host: 'legacy', reason: 'a11y' }
  if (term === 'dumb') return { host: 'legacy', reason: 'dumb-terminal' }
  if (!cursorAddressing) return { host: 'legacy', reason: 'unsupported-cursor-addressing' }
  if (optIn === '1' || optIn === 'true') return { host: 'north_star', reason: 'developer-opt-in' }
  if (input.ui4Qualified === true) return { host: 'north_star', reason: 'qualified-default' }
  return { host: 'legacy', reason: 'legacy-default' }
}
