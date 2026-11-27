import { parseCommandArgv } from './commandArgv.js'

const COMMAND_PROHIBITION = /^(?:please\s+)?(?:you\s+)?(?:do not|don['’]t|must not|never)\s+(?:(?:edit|change|modify)\b.*?\s+(?:or|and)\s+)?(?:run|execute)\s+(.+)$/i
const WHOLE_TASK_SCOPE = /\s+(?:during|throughout|for)\s+(?:this|the)\s+(?:task|session|run)$/i
export const GENERAL_COMMANDS = /^(?:(?:any|all|the)\s+)?(?:shell commands?|commands?|shell|scripts?)$/i
export const TESTS = /^(?:(?:any|all|the)\s+)?tests?(?:\s+suites?)?$/i

export function splitProse(text: string, separators: RegExp): string[] {
  const parts: string[] = []
  let start = 0
  const quoted = /`+[^`]+`+|"(?:\\.|[^"\\])*"|“[^”]*”|(?<!\w)'[^']*'|‘[^’]*’/
  const tokens = new RegExp(`${quoted.source}|(${separators.source})`, 'gi')
  for (const match of text.matchAll(tokens)) {
    if (match[1] === undefined) continue
    parts.push(text.slice(start, match.index).trim())
    start = match.index! + match[0].length
  }
  parts.push(text.slice(start).trim())
  return parts.filter(Boolean)
}

export function prohibitedCommandTargets(activeProse: readonly string[]): string[] {
  return activeProse.flatMap(line => {
    const prose = line.trim().replace(/^(?:[-*+•]|\d+[.)])\s+/, '').replace(/^requirements?:\s*/i, '')
    return splitProse(prose, /[.;!?](?=\s|$)/).flatMap(clause => {
      const target = COMMAND_PROHIBITION.exec(clause)?.[1]
      return target ? splitProse(target, /(?:,\s*(?:or|and)\s+|\s+(?:or|and)\s+|,\s+)/)
        .map(part => (COMMAND_PROHIBITION.exec(part)?.[1] ?? part).replace(WHOLE_TASK_SCOPE, '')) : []
    })
  })
}

function executableName(value: string): string {
  return value.replace(/\\/g, '/').split('/').at(-1)!.replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase()
}

/** Match a declared executable and argv prefix identically at admission and routing. */
export function prohibitedArgv(target: string, argv: readonly string[]): boolean {
  try {
    const denied = parseCommandArgv(target.replace(/^`([^`]+)`$/, '$1'))
    if (!denied[0] || !argv[0] || executableName(denied[0]) !== executableName(argv[0])) return false
    const normalize = (args: readonly string[]) =>
      executableName(args[0]!) === 'npm' && args[1] === 'run' && args[2] === 'test'
        ? [args[0]!, ...args.slice(2)] : args
    const requestedArgs = normalize(argv)
    return normalize(denied).slice(1).every((arg, index) => arg === requestedArgs[index + 1])
  } catch { return false }
}
