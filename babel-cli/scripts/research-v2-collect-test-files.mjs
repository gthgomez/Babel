#!/usr/bin/env node
/**
 * Truly recursive research v2 test manifest for checkpoint verification.
 * Emits one path per line (repo-relative from babel-cli/).
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', 'src', 'research', 'v2')

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(full)))
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(full)
    }
  }
  return files
}

const v2Tests = await walk(root)
const cliTests = [
  join(import.meta.dirname, '..', 'src', 'commands', 'researchV2Commands.test.ts'),
  join(import.meta.dirname, '..', 'src', 'commands', 'researchV2Commands.repair.test.ts'),
]

const babelRoot = join(import.meta.dirname, '..')
const rel = (abs) => abs.replace(babelRoot + '/', '')

const all = [...v2Tests, ...cliTests].map(rel).sort()
for (const file of all) {
  process.stdout.write(`${file}\n`)
}
