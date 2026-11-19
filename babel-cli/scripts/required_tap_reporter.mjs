// License: Apache-2.0 — see LICENSE
import { tap } from 'node:test/reporters'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const TOP_LEVEL_EVENTS = new Set(['test:start', 'test:pass', 'test:fail'])

/**
 * Prefix a root test name with its selected source file.
 *
 * Node's TAP reporter emits top-level `test()`/`describe()` names without the
 * file that declared them, so two distinct files that use the same suite and
 * case titles produce identical TAP ids. Prefixing only nesting===0 keeps
 * nested paths intact and makes every id bind to one executed source file.
 */
export function qualifiedTopLevelName(event, cwd = process.cwd()) {
  const data = event?.data
  if (!TOP_LEVEL_EVENTS.has(event?.type) || data?.nesting !== 0) return null
  const file = typeof data.entryFile === 'string' ? data.entryFile : data.file
  if (typeof file !== 'string' || typeof data.name !== 'string') return null
  const path = relative(cwd, file).replaceAll('\\', '/')
  if (!path || path.startsWith('../') || path === '..') return null
  return `${path} :: ${data.name}`
}

/** Preserve raw TAP and bind completed file events to their source content. */
export default async function* requiredTapReporter(source) {
  const files = new Map()
  const skips = []
  const timings = []
  const outputPath = process.env.BABEL_TAP_EXECUTION_PATH
  const selection = outputPath ? JSON.parse(readFileSync(resolve(dirname(outputPath), 'selection.json'), 'utf8')).files : []
  const selected = new Set(selection.map(file => file.path))
  async function* observe() {
    for await (const event of source) {
      if (event.type === 'test:summary' && event.data.file && Number.isFinite(event.data.duration_ms) && event.data.duration_ms > 0) {
        const path = relative(process.cwd(), event.data.file).replaceAll('\\', '/')
        if (selected.has(path) && files.has(path)) timings.push({ path, sha256: files.get(path), durationMs: event.data.duration_ms })
      }
      if (['test:pass', 'test:fail'].includes(event.type) && event.data.file) {
        const path = event.data.entryFile || event.data.file
        const name = relative(process.cwd(), path).replaceAll('\\', '/')
        if (selected.has(name)) {
          const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
          files.set(name, sha256)
          if (event.data.skip) {
            // Skip policy records the bare authored title; the TAP id carries
            // the source-file prefix added below.
            skips.push({
              path: name,
              sha256,
              name: event.data.name,
              reason: typeof event.data.skip === 'string' ? event.data.skip : 'unspecified',
            })
          }
        }
      }
      const qualified = qualifiedTopLevelName(event)
      if (qualified !== null) {
        yield { ...event, data: { ...event.data, name: qualified } }
      } else {
        yield event
      }
    }
    const path = process.env.BABEL_TAP_EXECUTION_PATH
    if (path) {
      mkdirSync(dirname(resolve(path)), { recursive: true })
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, complete: true, nodeVersion: process.version,
        platform: process.platform, arch: process.arch,
        files: [...files].map(([path, sha256]) => ({ path, sha256 })), skips, timings }, null, 2) + '\n')
    }
  }
  yield* tap(observe())
}
