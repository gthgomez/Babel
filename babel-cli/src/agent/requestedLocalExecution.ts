import { resolve } from 'node:path'
import { mandatoryVerifierProse } from '../config/verifierIntent.js'
import { parseCommandArgv } from '../utils/commandArgv.js'
import { inferTaskAcceptanceV1 } from './taskAcceptanceMeaning.js'

/** Match a narrow, explicit request to run a just-created local exporter. */
export function requestsLocalExporterExecution(task: string, command: string, projectRoot: string, changedPaths: readonly string[]): boolean {
  let argv: string[]
  try {
    argv = parseCommandArgv(command)
  } catch {
    return false
  }
  const [runtime, script, input, output] = argv
  if (argv.length !== 4 || !runtime || !script || !input || !output || !/^python(?:3(?:\.\d+)?)?$/.test(runtime)) return false
  if (!/^[\w.-]+\.py$/.test(script) || ![input, output].every(path => /^[\w.-]+\.[\w-]+$/.test(path))) return false
  const scriptPath = resolve(projectRoot, script)
  if (!changedPaths.some(path => resolve(projectRoot, path) === scriptPath)) return false

  const prose = inferTaskAcceptanceV1(task.replace(/^(?: {4,}| {0,3}\t).*$/gm, '')).activeProse.join('\n')
  if (/\b(?:do\s+not|don['’]t|never|skip|avoid)\s+(?:run|execute|running|executing)\b/i.test(prose)) return false
  const clauses = mandatoryVerifierProse(prose).split(/[.!?](?=\s|$)|[;\r\n]/).map(clause => clause.trim())
  const declared = clauses.flatMap(clause => {
    const path = /^(?:please\s+)?(?:add|create|write)\s+([\w.-]+\.py)(?=$|[ ,])/i.exec(clause)?.[1]
    return path ? [path] : []
  })
  if (declared.length !== 1 || declared[0] !== script) return false
  return clauses.some(clause => {
    if (/\b(?:if|unless|when)\b/i.test(clause)) return false
    const match = /^(?:please\s+)?(?:run|execute)\s+the exporter\s+to\s+(?:create|generate)\s+([\w.-]+)\s+from\s+([\w.-]+)(?:\s+and\s+leave\b.*)?$/i.exec(clause)
    return match?.[1] === output && match[2] === input
  })
}
