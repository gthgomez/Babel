// License: Apache-2.0 — see LICENSE
import { tap } from 'node:test/reporters'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

/** Preserve raw TAP and bind completed file events to their source content. */
export default async function* requiredTapReporter(source) {
  const files = new Map()
  const skips = []
  const outputPath = process.env.BABEL_TAP_EXECUTION_PATH
  const selection = outputPath ? JSON.parse(readFileSync(resolve(dirname(outputPath), 'selection.json'), 'utf8')).files : []
  const selected = new Set(selection.map(file => file.path))
  async function* observe() {
    for await (const event of source) {
      if (['test:pass', 'test:fail'].includes(event.type) && event.data.file) {
        const path = event.data.entryFile || event.data.file
        const name = relative(process.cwd(), path).replaceAll('\\', '/')
        if (selected.has(name)) {
          const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
          files.set(name, sha256)
          if (event.data.details?.type === 'test' && event.data.skip) {
            skips.push({ path: name, sha256, name: event.data.name,
              reason: typeof event.data.skip === 'string' ? event.data.skip : 'unspecified' })
          }
        }
      }
      yield event
    }
    const path = process.env.BABEL_TAP_EXECUTION_PATH
    if (path) {
      mkdirSync(dirname(resolve(path)), { recursive: true })
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, complete: true, nodeVersion: process.version,
        platform: process.platform, arch: process.arch,
        files: [...files].map(([path, sha256]) => ({ path, sha256 })), skips }, null, 2) + '\n')
    }
  }
  yield* tap(observe())
}
