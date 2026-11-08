import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseCommandArgv } from '../utils/commandArgv.js'

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

/**
 * Resolve the project-declared `test` script behind a package-manager
 * invocation. `npm test` carries the right authority but hides the runner that
 * actually executed, so count parsing otherwise has no family to bind to.
 * Returns the script text verbatim; it is used for identity/count analysis
 * only, never executed here.
 */
export function resolveDeclaredTestCommand(
  projectRoot: string,
  command: string,
): string | undefined {
  let argv: string[]
  try {
    argv = parseCommandArgv(command.trim())
  } catch {
    return undefined
  }
  if (argv.length === 0) return undefined
  const executable = path
    .basename(argv[0]!)
    .toLowerCase()
    .replace(/\.(cmd|bat|exe)$/i, '')
  if (!PACKAGE_MANAGERS.has(executable)) return undefined
  const scriptName = argv[1] === 'test'
    ? 'test'
    : argv[1] === 'run' && argv[2]
      ? argv[2]
      : undefined
  if (scriptName !== 'test') return undefined
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, unknown> }
    const script = parsed.scripts?.['test']
    return typeof script === 'string' && script.trim().length > 0
      ? script.trim()
      : undefined
  } catch {
    return undefined
  }
}
