import { readFileSync } from 'node:fs'

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

console.log(`test:chat-truth selected files (${files.length}):`)
for (const file of files) console.log(`- ${file}`)
