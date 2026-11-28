import { parseCommandArgv } from '../utils/commandArgv.js'
import { GENERAL_COMMANDS, TESTS, foregroundDenialTargets, invokesProhibitedScript, prohibitedArgv, prohibitedCommandTargets, splitProse } from '../utils/commandDenialProse.js'
import { explicitNodeTestFileArgs, hasVerifierShellComposition, isAuthoritativeVerifierCommand } from './completionGatePolicy.js'

const LEGACY_PROHIBITION = /^(?:do not|don't|never)\s+(?:(?:edit|change|modify)\b[^.;!?]*?\s+(?:or|and)\s+)?(?:run|execute)\s+(.+)$/i
const V3_PROHIBITION = /^(?:please\s+)?(?:do not|don['’]t|never)\s+(?:(?:edit|change|modify)\b.*?\s+(?:or|and)\s+)?(?:run|execute)\s+(.+)$/i

/** Honor explicit command denials from active operator prose, including verifier dispatch. */
export function taskProhibitsCommand(activeProse: readonly string[], command: string): boolean {
  return prohibitsCommand(prohibitedCommandTargets(activeProse), command)
}

/** Apply current script-specific denials at fresh foreground admission and dispatch. */
export function taskProhibitsForegroundCommand(
  activeProse: readonly string[], command: string, projectRoot = process.cwd(), cwd = '.',
): boolean {
  const { commands, scripts, unresolvedReference } = foregroundDenialTargets(activeProse)
  if (prohibitsCommand(commands, command)) return true
  if (scripts.length === 0 && !unresolvedReference) return false
  if (hasVerifierShellComposition(command)) return true
  try {
    const argv = parseCommandArgv(command)
    // An unidentified script can block execution while leaving an exact repository inspection available.
    if (unresolvedReference && (argv.length !== 2 || argv[0] !== 'git' || argv[1] !== 'status')) return true
    return scripts.length > 0 && invokesProhibitedScript(argv, scripts, projectRoot, cwd, explicitNodeTestFileArgs)
  }
  catch { return true }
}

/** Replay the prohibition grammar used by V2 acceptance amendment descriptors. */
export function legacyTaskProhibitsCommand(activeProse: readonly string[], command: string): boolean {
  const targets = activeProse.flatMap(line => line
    .split(/[.;!?](?=\s+(?:do not|don't|never)\b|$)/i)
    .map(clause => clause.trim().replace(/^(?:[-*+•]|\d+[.)])\s+/, '').replace(/^requirements?:\s*/i, ''))
    .flatMap(clause => LEGACY_PROHIBITION.exec(clause)?.[1]?.trim() ?? []))
  if (targets.some(target => target.split(/\s+(?:or|and)\s+/i).some(part => GENERAL_COMMANDS.test(part)))) return true
  return prohibitsCommand(targets, command)
}

/** Replay the grammar used by V3, before scoped and repeated denials were recognized. */
export function v3TaskProhibitsCommand(activeProse: readonly string[], command: string): boolean {
  const targets = activeProse.flatMap(line => splitProse(
    line.trim().replace(/^(?:[-*+•]|\d+[.)])\s+/, '').replace(/^requirements?:\s*/i, ''),
    /[.;!?](?=\s|$)/,
  ).flatMap(clause => {
    const target = V3_PROHIBITION.exec(clause)?.[1]
    return target ? splitProse(target, /\s+(?:or|and)\s+|,\s+/) : []
  }))
  return prohibitsCommand(targets, command)
}

function prohibitsCommand(targets: string[], command: string): boolean {
  if (targets.length === 0) return false
  if (targets.some(target => GENERAL_COMMANDS.test(target))) return true
  if (hasVerifierShellComposition(command)) return true
  let argv: string[]
  try { argv = parseCommandArgv(command) } catch { return true }
  if (!argv[0]) return true
  return targets.some(target => TESTS.test(target) ? isAuthoritativeVerifierCommand(command) : prohibitedArgv(target, argv))
}
