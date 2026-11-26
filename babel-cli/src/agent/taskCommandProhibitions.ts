import { parseCommandArgv } from '../utils/commandArgv.js'
import { hasVerifierShellComposition, isAuthoritativeVerifierCommand } from './completionGatePolicy.js'

const COMMAND_PROHIBITION = /^(?:please\s+)?(?:do not|don['’]t|never)\s+(?:(?:edit|change|modify)\b.*?\s+(?:or|and)\s+)?(?:run|execute)\s+(.+)$/i
const GENERAL_COMMANDS = /^(?:(?:any|all|the)\s+)?(?:shell commands?|commands?|shell|scripts?)$/i
const TESTS = /^(?:(?:any|all|the)\s+)?tests?(?:\s+suites?)?$/i

function executableName(value: string): string {
  return value.replace(/\\/g, '/').split('/').at(-1)!.replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase()
}

function splitProse(text: string, separators: RegExp): string[] {
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

function commandTargets(line: string): string[] {
  const prose = line.trim().replace(/^(?:[-*+•]|\d+[.)])\s+/, '').replace(/^requirements?:\s*/i, '')
  return splitProse(prose, /[.;!?](?=\s|$)/).flatMap(clause => {
    const target = COMMAND_PROHIBITION.exec(clause)?.[1]
    return target ? splitProse(target, /\s+(?:or|and)\s+|,\s+/) : []
  })
}

/** Honor explicit command denials from active operator prose, including verifier dispatch. */
export function taskProhibitsCommand(activeProse: readonly string[], command: string): boolean {
  const targets = activeProse.flatMap(commandTargets)
  if (targets.length === 0) return false
  if (targets.some(target => GENERAL_COMMANDS.test(target))) return true
  if (hasVerifierShellComposition(command)) return true
  let argv: string[]
  try { argv = parseCommandArgv(command) } catch { return true }
  if (!argv[0]) return true
  return targets.some(target => {
    if (TESTS.test(target)) return isAuthoritativeVerifierCommand(command)
    try {
      const denied = parseCommandArgv(target.replace(/^`([^`]+)`$/, '$1'))
      if (!denied[0] || executableName(denied[0]) !== executableName(argv[0]!)) return false
      const normalize = (args: string[]) =>
        executableName(args[0]!) === 'npm' && args[1] === 'run' && args[2] === 'test'
          ? [args[0]!, ...args.slice(2)]
          : args
      const requestedArgs = normalize(argv)
      return normalize(denied).slice(1).every((arg, index) => arg === requestedArgs[index + 1])
    } catch {
      return false
    }
  })
}
