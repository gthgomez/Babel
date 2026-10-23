// License: Apache-2.0 — see LICENSE
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Merge completed unit execution artifacts. Timings are hints, never accepted test evidence. */
export function updateUnitDurations(current, artifacts) {
  const result = structuredClone(current ?? { schemaVersion: 1, platforms: {} })
  if (result.schemaVersion !== 1 || !result.platforms) throw new Error('Invalid timing inventory')
  for (const artifact of artifacts) {
    if (artifact.complete !== true || !['win32', 'linux', 'darwin'].includes(artifact.platform) || !Array.isArray(artifact.files) || !Array.isArray(artifact.timings)) throw new Error('Incomplete execution artifact')
    const files = new Map(artifact.files.map(file => [file.path, file.sha256]))
    const timings = result.platforms[artifact.platform] ??= {}
    for (const entry of artifact.timings) {
      if (!/^src\/[A-Za-z0-9_./-]+\.test\.ts$/.test(entry.path) || entry.path.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(entry.sha256) || files.get(entry.path) !== entry.sha256 || !Number.isFinite(entry.durationMs) || entry.durationMs <= 0 || entry.durationMs > 86400000) throw new Error('Invalid timing observation')
      timings[entry.path] = { sha256: entry.sha256, durationMs: Math.round(entry.durationMs) }
    }
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../config/ci-unit-durations.json')
  if (!process.argv.slice(2).length) throw new Error('Provide completed unit execution.json artifacts')
  const result = updateUnitDurations(existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : null, process.argv.slice(2).map(path => JSON.parse(readFileSync(path, 'utf8'))))
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
}
