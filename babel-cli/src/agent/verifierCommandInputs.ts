/**
 * Resolve the concrete input files a trusted verifier command executes.
 *
 * Relevance binding and protected-input freezing need the same view of what a
 * command reads: explicit `node --test` operands, an npm script's statically
 * named test files, or a direct node file. Unknown or dynamic command shapes
 * return no inputs and therefore never become relevance witnesses.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { explicitNodeTestFileArgs } from './completionGatePolicy.js'
import { resolveExistingVerifierInputPaths, type VerifierInputPathFs } from './verifierInputPaths.js'

export interface VerifierCommandInputFs extends VerifierInputPathFs {
  readFile?: (path: string) => string | null
}

/** Test/caller overrides; missing members fall back to the real filesystem. */
export type VerifierCommandInputOverrides = Partial<VerifierCommandInputFs>

const DEFAULT_FS: Required<VerifierCommandInputFs> = {
  exists: existsSync,
  isFile: (path) => {
    try { return statSync(path).isFile() } catch { return false }
  },
  realpath: (path) => {
    try { return realpathSync.native(path) } catch { return null }
  },
  readFile: (path) => {
    try { return readFileSync(path, 'utf8') } catch { return null }
  },
}

const TEST_FILE_TOKEN_RE = /[\w@./\\-]+\.(?:[cm]?[jt]sx?|py|rb|go|rs|sh)\b/g
const PACKAGE_JSON = 'package.json'

function resolveInputs(
  projectRoot: string,
  tokens: readonly string[],
  fs: VerifierCommandInputFs,
): string[] {
  return resolveExistingVerifierInputPaths(projectRoot, tokens, fs)
}

/**
 * Existing input files for one command, normalized to project-relative paths.
 * `package.json` is included for npm-script commands because the script body is
 * itself part of the verifier definition.
 */
export function verifierCommandInputFiles(
  projectRoot: string,
  command: string,
  fs: VerifierCommandInputOverrides = {},
): string[] {
  const merged: Required<VerifierCommandInputFs> = { ...DEFAULT_FS, ...fs }
  const nodeTestOperands = explicitNodeTestFileArgs(command)
  if (nodeTestOperands !== null) {
    return [...new Set(resolveInputs(projectRoot, nodeTestOperands, merged))].sort()
  }
  const npmRun = command.match(/^npm\s+(?:run\s+)?([\w:.-]+)\s*$/)
  if (npmRun) {
    const packageText = merged.readFile(join(projectRoot, PACKAGE_JSON))
    if (!packageText) return []
    let scripts: Record<string, unknown> | undefined
    try {
      scripts = (JSON.parse(packageText) as { scripts?: Record<string, unknown> }).scripts
    } catch {
      return []
    }
    const script = scripts?.[npmRun[1]!]
    if (typeof script !== 'string' || script.trim().length === 0) return []
    const files = new Set<string>()
    if (merged.exists(join(projectRoot, PACKAGE_JSON))) files.add(PACKAGE_JSON)
    const nodeTestOperands = explicitNodeTestFileArgs(script)
    const tokens = nodeTestOperands?.length ? nodeTestOperands :
      [...script.matchAll(TEST_FILE_TOKEN_RE)].map(match => match[0])
    for (const path of resolveInputs(projectRoot, tokens, merged)) files.add(path)
    return [...files].sort()
  }
  const directNode = command.match(/^node\s+(?!(?:-e|--test|--check)\b)(\S+)\s*$/)
  if (directNode) {
    return [...new Set(resolveInputs(projectRoot, [directNode[1]!], merged))].sort()
  }
  return []
}

/** Read an admitted verifier input as UTF-8; null when it cannot be read. */
export function readVerifierCommandInput(
  projectRoot: string,
  relativePath: string,
  fs: VerifierCommandInputOverrides = {},
): string | null {
  const merged: Required<VerifierCommandInputFs> = { ...DEFAULT_FS, ...fs }
  return merged.readFile(join(projectRoot, relativePath))
}
