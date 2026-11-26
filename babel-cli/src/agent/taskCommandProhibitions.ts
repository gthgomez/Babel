import { parseCommandArgv } from '../utils/commandArgv.js'
import { hasVerifierShellComposition, isAuthoritativeVerifierCommand } from './completionGatePolicy.js'

const COMMAND_PROHIBITION = /^(?:do not|don't|never)\s+(?:(?:edit|change|modify)\b[^.;!?]*?\s+(?:or|and)\s+)?(?:run|execute)\s+(.+)$/i
const GENERAL_COMMANDS = /^(?:(?:any|all|the)\s+)?(?:shell commands?|commands?|shell|scripts?)$/i
const TESTS = /^(?:(?:any|all|the)\s+)?tests?(?:\s+suites?)?$/i

function executableName(value: string): string {
  return value.replace(/\\/g, '/').split('/').at(-1)!.replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase()
}

function commandTargets(activeProse: readonly string[]): string[] {
  return activeProse.flatMap(line => line
    .split(/[.;!?](?=\s+(?:do not|don't|never)\b|$)/i)
    .map(clause => clause.trim().replace(/^(?:[-*+•]|\d+[.)])\s+/, '').replace(/^requirements?:\s*/i, ''))
    .flatMap(clause => COMMAND_PROHIBITION.exec(clause)?.[1]?.trim() ?? []))
}

/** Honor explicit command denials from active operator prose, including verifier dispatch. */
export function taskProhibitsCommand(activeProse: readonly string[], command: string): boolean {
  const targets = commandTargets(activeProse)
  if (targets.length === 0) return false
  if (targets.some(target => target.split(/\s+(?:or|and)\s+/i).some(part => GENERAL_COMMANDS.test(part)))) return true
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
