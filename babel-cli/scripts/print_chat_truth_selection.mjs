import { existsSync, readFileSync } from 'node:fs'

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

console.log(`test:chat-truth selected files (${files.length}):`)
for (const file of files) console.log(`- ${file}`)
