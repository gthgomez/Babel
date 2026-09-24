import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
const root = dirname(packagePath)
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))

function walkTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return walkTestFiles(path)
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : []
  })
}

function resolveSelector(selector) {
  if (selector.includes('*')) {
    const match = /^(.*)\/\*\*\/\*\.test\.ts$/.exec(selector)
    if (!match) throw new Error(`Unsupported TAP test selector pattern: ${selector}`)
    const directory = resolve(root, match[1])
    if (!existsSync(directory)) throw new Error(`Selected test directory is missing: ${selector}`)
    return walkTestFiles(directory)
  }
  const path = resolve(root, selector)
  if (!existsSync(path)) throw new Error(`Selected test file is missing: ${selector}`)
  return [path]
}

export function captureRequiredTapSelection(suite, artifactDirectory) {
  if (!['chat-truth', 'harness-runtime'].includes(suite)) {
    throw new Error(`Unsupported required TAP suite: ${suite}`)
  }
  const command = packageJson.scripts?.[`test:${suite}`]
  const marker = ' --test '
  if (typeof command !== 'string' || !command.includes(marker)) {
    throw new Error(`test:${suite} must contain an explicit --test file list`)
  }
  const selectors = command.slice(command.indexOf(marker) + marker.length).trim().split(/\s+/)
  const paths = selectors.flatMap(resolveSelector)
  const unique = new Set(paths)
  if (paths.length === 0 || unique.size !== paths.length) {
    throw new Error(`test:${suite} has an empty or duplicate selected-file inventory`)
  }
  const files = paths.map((path) => ({
    path: relative(root, path).split(sep).join('/'),
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }))
  const summary = {
    schemaVersion: 1,
    suite,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    packageScriptSha256: createHash('sha256').update(command).digest('hex'),
    files,
  }
  const directory = resolve(artifactDirectory)
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, 'selection.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`${suite} selected files (${files.length}):`)
  for (const file of files) console.log(`- ${file.path}`)
  return summary
}

const suite = process.argv[2]
if (suite) {
  const artifactDirectory = process.argv[3] ?? fileURLToPath(new URL(`../artifacts/${suite}/`, import.meta.url))
  captureRequiredTapSelection(suite, artifactDirectory)
}
