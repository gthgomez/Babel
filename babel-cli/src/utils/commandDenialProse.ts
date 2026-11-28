import { formatArgvAsCommand, parseCommandArgv } from './commandArgv.js'
import { physicalWorkspacePath, resolveSandboxProjectPath, workspaceMountPath } from './projectPath.js'

const COMMAND_PROHIBITION = /^(?:please\s+)?(?:you\s+)?(?:do not|don['’]t|must not|never)\s+(?:(?:edit|change|modify)\b.*?\s+(?:or|and)\s+)?(?:run|execute)\s+(.+)$/i
const WHOLE_TASK_SCOPE = /\s+(?:during|throughout|for)\s+(?:this|the)\s+(?:task|session|run)$/i
export const LOCAL_SCRIPT_PATH = String.raw`(?:\./)?[\p{L}\p{N}_-][\p{L}\p{N}_.\/-]*\.(?:py|[cm]?js)`
const SCRIPT_TARGET = /^(?:(?:[a-z]:)?\/)?(?:\.\/)?[\p{L}\p{N}_-][\p{L}\p{N}_ .\/-]*\.(?:py|[cm]?js)$/iu
const SCRIPT_DECLARATION = /^(?:please\s+)?(?:add|create|write|fix|repair|update|run|execute)\s+(`[^`]+`|"[^"]+"|'[^']+'|[^\s,]+)/i
const UNNAMED_SCRIPT_REPAIR = /^(?:please\s+)?(?:fix|repair|update)\s+the\s+(?:exporter|script)\b/i
const SCRIPT_PROHIBITION = /^(?:please\s+)?(?:you\s+)?(?:do not|don['’]t|must not|never)\s+(?:(?:actually|directly)\s+)?(?:run|execute)\s+(.+)$/i
const SCRIPT_REFERENCE = /^(?:it|the (?:exporter|script))$/i
const GENERATION_PROHIBITION = /^(?:please\s+)?(?:you\s+)?(?:do not|don['’]t|must not|never)\s+generate\s+(.+)$/i
const NAMED_OUTPUT = /^(?:(?:[a-z]:)?\/)?(?:\.\/)?[\p{L}\p{N}_-][\p{L}\p{N}_ .\/-]*\.[\p{L}\p{N}_-]+$/iu
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

function namedPath(target: string, pattern: RegExp): string | undefined {
  const unquoted = /^(?:`([^`]+)`|"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’)$/u.exec(target)
  const path = (unquoted?.slice(1).find(part => part !== undefined) ?? target).replace(/\\/g, '/')
  return (unquoted || !/\s/.test(path)) && pattern.test(path) ? path : undefined
}

/** Read current denials without changing the historical amendment grammar. */
export function foregroundDenialTargets(activeProse: readonly string[]): {
  commands: string[]; scripts: string[]; outputs: string[]; unresolvedReference: boolean
} {
  const clauses = activeProse.flatMap(line => splitProse(
    line.trim().replace(/^(?:[-*+•]|\d+[.)])\s+/, '').replace(/^requirements?:\s*/i, ''),
    /[.;!?](?=\s|$)|,?\s+but\s+(?=(?:please\s+)?(?:you\s+)?(?:do not|don['’]t|must not|never)\b)/,
  )).map(clause => clause.replace(/^(?:also|additionally|and)\b[\s,:]*/i, ''))
  const declared = new Set<string>()
  const commands: string[] = []
  const scripts = new Set<string>()
  const outputs = new Set<string>()
  let unresolvedReference = false
  let unnamedRepair = false
  for (const clause of clauses) {
    const declaration = namedPath(SCRIPT_DECLARATION.exec(clause)?.[1] ?? '', SCRIPT_TARGET)
    if (declaration) {
      declared.add(declaration)
    } else if (UNNAMED_SCRIPT_REPAIR.test(clause)) {
      unnamedRepair = true
    }
    const generated = GENERATION_PROHIBITION.exec(clause)?.[1]
    const target = generated ? `generate ${generated}` : COMMAND_PROHIBITION.exec(clause)?.[1] ?? SCRIPT_PROHIBITION.exec(clause)?.[1]
    if (!target) continue
    let generating = false
    for (const part of splitProse(target, /(?:,\s*(?:or|and)\s+|\s+(?:or|and)\s+|,\s+)/)) {
      const output = GENERATION_PROHIBITION.exec(part)?.[1] ?? /^generate\s+(.+)$/i.exec(part)?.[1]
      const command = COMMAND_PROHIBITION.exec(part)?.[1] ?? SCRIPT_PROHIBITION.exec(part)?.[1] ??
        /^(?:run|execute)\s+(.+)$/i.exec(part)?.[1]
      if (output !== undefined) generating = true
      if (command !== undefined) generating = false
      if (generating) {
        const path = namedPath((output ?? part).replace(WHOLE_TASK_SCOPE, ''), NAMED_OUTPUT)
        if (path) outputs.add(path)
        continue
      }
      const name = (command ?? part).replace(WHOLE_TASK_SCOPE, '')
      const literal = namedPath(name, SCRIPT_TARGET)
      if (literal) scripts.add(literal)
      // A quoted string with spaces can also name command argv. Keep that
      // reading without giving a single named path legacy basename matching.
      if (!literal || /\s/.test(literal)) commands.push(name)
      if (SCRIPT_REFERENCE.test(name)) {
        if (unnamedRepair || declared.size === 0) unresolvedReference = true
        else for (const path of declared) scripts.add(path)
      }
    }
  }
  return { commands, scripts: [...scripts], outputs: [...outputs], unresolvedReference }
}

function executableName(value: string): string {
  return value.replace(/\\/g, '/').split('/').at(-1)!.replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase()
}

function scriptPathKey(base: string, path: string): string {
  const absolute = physicalWorkspacePath(base, path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Match the executable or interpreter entry point, while allowing filenames used as data. */
export function invokesProhibitedScript(
  argv: readonly string[], targets: readonly string[], projectRoot: string, cwd: string,
  nodeTestFiles: (command: string) => readonly string[] | null,
  entryOperands?: (operands: readonly string[]) => boolean,
): boolean {
  const [program, ...args] = argv
  if (!program) return false
  const launcher = executableName(program)
  const workingDirectory = physicalWorkspacePath(projectRoot, resolveSandboxProjectPath(projectRoot, cwd, true))
  const denied = new Set(targets.map(target => scriptPathKey(projectRoot, workspaceMountPath(target, true) ?? target)))
  const matches = (entry: string) => {
    const mounted = workspaceMountPath(entry, true)
    return denied.has(mounted === undefined ? scriptPathKey(workingDirectory, entry) : scriptPathKey(projectRoot, mounted))
  }
  const matchesEntry = (entry: string, operandIndex: number) =>
    matches(entry) && (entryOperands === undefined || entryOperands(args.slice(operandIndex)))
  const python = /^(?:python(?:3(?:\.\d+)?)?|py)$/.test(launcher)
  const node = launcher === 'node' || launcher === 'nodejs'
  const jsRunner = node || /^(?:bun|deno|tsx|ts-node)$/.test(launcher)
  const matchesTestFiles = (operands: readonly string[]) => operands.some(target => !target.startsWith('-') && matches(target.split('::')[0]!))
  if (launcher === 'pytest') return entryOperands === undefined && matchesTestFiles(args)
  if (!python && !jsRunner) return matchesEntry(program, 0)

  const start = (launcher === 'bun' || launcher === 'deno') && args[0] === 'run' ? 1 : 0
  for (let index = start; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') return args[index + 1] !== undefined && matchesEntry(args[index + 1]!, index + 2)
    if (!arg.startsWith('-')) return matchesEntry(arg, index + 1)
    if (!python && /^(?:--no-warnings|--enable-source-maps|--no-deprecation)$/.test(arg)) continue
    if (node && arg === '--test') {
      const files = nodeTestFiles(formatArgvAsCommand(['node', ...args.slice(index)]))
      return entryOperands === undefined && (!files?.length || files.some(matches))
    }
    if (python && /^(?:-3(?:\.\d+)?|-[bBEIOPSqsSuv]+)$/.test(arg)) continue
    if (python && /^-[WX]/.test(arg)) {
      if (arg.length === 2) index++
      continue
    }
    if (python && /^-m/.test(arg)) {
      const name = arg.slice(2) || args[++index]
      if (!name) return true
      const module = name.replace(/\./g, '/')
      if (matchesEntry(`${module}.py`, index + 1) || matchesEntry(`${module}/__main__.py`, index + 1)) return true
      if (entryOperands !== undefined) return false
      if (name === 'pytest') return matchesTestFiles(args.slice(index + 1))
      if (name !== 'doctest' && name !== 'unittest') return false
      return args.slice(index + 1).filter(target => !target.startsWith('-')).some(target =>
        matches(target) || (name === 'unittest' && matches(`${target.replace(/\./g, '/')}.py`)))
    }
    if (/^(?:-V|--version|--help)$/.test(arg)) return false
    // An unrecognized mode can load or evaluate code before a positional entry point.
    return entryOperands === undefined
  }
  return entryOperands === undefined // An interpreter without an entry point can receive code on stdin.
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
