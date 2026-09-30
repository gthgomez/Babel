import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)
const selector = packageJson.scripts?.['test:chat-truth']
const marker = ' --test '

if (typeof selector !== 'string' || !selector.includes(marker)) {
  throw new Error('test:chat-truth must contain an explicit --test file list')
}

const files = selector.slice(selector.indexOf(marker) + marker.length).trim().split(/\s+/)
if (files.length === 0 || files.some((file) => file.includes('*'))) {
  throw new Error('test:chat-truth file list must be explicit and non-empty')
}

const missing = files.filter((file) => !existsSync(new URL(`../${file}`, import.meta.url)))
if (missing.length > 0) {
  throw new Error(`test:chat-truth selected files are missing: ${missing.join(', ')}`)
}

const artifacts = new URL('../artifacts/chat-truth/', import.meta.url)
mkdirSync(artifacts, { recursive: true })
const manifest = {
  schemaVersion: 1,
  suite: 'test:chat-truth',
  nodeVersion: process.version,
  tsxVersion: JSON.parse(readFileSync(new URL('../node_modules/tsx/package.json', import.meta.url), 'utf8')).version,
  platform: process.platform,
  arch: process.arch,
  files: files.map((file) => ({
    path: file,
    sha256: createHash('sha256').update(readFileSync(new URL(`../${file}`, import.meta.url))).digest('hex'),
  })),
}
writeFileSync(new URL('selection.json', artifacts), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`test:chat-truth selected files (${files.length}):`)
for (const file of files) console.log(`- ${file}`)
