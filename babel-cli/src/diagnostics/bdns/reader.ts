/** Read-only operator/agent loader for persisted BDNS evidence. */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { toSafeBdnsValue } from './serialization.js'

export interface BdnsDiagnosticBundle {
  status: 'available' | 'missing' | 'corrupt'
  runDir: string
  summary: unknown | null
  incidents: unknown[]
  observations: unknown[]
  errors: string[]
}

const MAX_READ_BYTES = 10 * 1024 * 1024
const MAX_READ_RECORDS = 4_096

async function readJson(path: string): Promise<unknown | null> {
  try {
    if ((await stat(path)).size > MAX_READ_BYTES) throw new Error('BDNS summary exceeds read limit')
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function readJsonl(path: string): Promise<{ values: unknown[]; error: string | null }> {
  try {
    if ((await stat(path)).size > MAX_READ_BYTES) throw new Error('BDNS JSONL exceeds read limit')
    const lines = (await readFile(path, 'utf8')).split(/\r?\n/u).filter((line) => line.trim())
    const values: unknown[] = []
    for (const line of lines.slice(0, MAX_READ_RECORDS)) values.push(JSON.parse(line))
    return { values, error: null }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { values: [], error: null }
    }
    return { values: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/** Load bounded BDNS files without making them semantic truth. */
export async function loadBdnsDiagnosticBundle(runDir: string): Promise<BdnsDiagnosticBundle> {
  const root = join(runDir, 'diagnostics', 'bdns')
  const summary = await readJson(join(root, 'bdns-summary.json'))
  const incidents = await readJsonl(join(root, 'bdns-incidents.jsonl'))
  const observations = await readJsonl(join(root, 'bdns-observations.jsonl'))
  const errors = [incidents.error, observations.error].filter((error): error is string => error !== null)
  const available = summary !== null || incidents.values.length > 0 || observations.values.length > 0
  return {
    status: errors.length > 0 && !available ? 'corrupt' : available ? 'available' : 'missing',
    runDir,
    summary: summary === null ? null : toSafeBdnsValue(summary),
    incidents: incidents.values.map(toSafeBdnsValue),
    observations: observations.values.map(toSafeBdnsValue),
    errors,
  }
}

/** Compact human-readable projection; facts and hypotheses stay visibly separate. */
export function formatBdnsDiagnosticHuman(bundle: BdnsDiagnosticBundle): string {
  const summary = bundle.summary as Record<string, unknown> | null
  const lines = [
    `BDNS: ${bundle.status}`,
    `Run: ${bundle.runDir}`,
    `Evidence: ${String(summary?.evidenceState ?? 'unknown')}`,
    `Observations: ${String(summary?.observations ?? bundle.observations.length)}`,
    `Incidents: ${String(summary?.incidents ?? bundle.incidents.length)}`,
  ]
  if (bundle.errors.length > 0) lines.push(`Storage errors: ${bundle.errors.join('; ')}`)
  const hypotheses = Array.isArray(summary?.hypotheses) ? summary.hypotheses : []
  if (hypotheses.length > 0) {
    lines.push('HYPOTHESES:')
    for (const hypothesis of hypotheses.slice(0, 8)) lines.push(`- ${String(hypothesis)}`)
  }
  if (bundle.incidents.length > 0) {
    lines.push('INCIDENTS:')
    for (const incident of bundle.incidents.slice(0, 8)) {
      const item = incident as Record<string, unknown>
      lines.push(`- ${String(item.category ?? 'UNKNOWN')} (${String(item.confidence ?? 'unknown')})`)
    }
  }
  return lines.join('\n')
}
