import { analyzeVerifierIdentity } from '../services/verifierIdentity.js'

/** Preserve only a complete, arithmetically consistent native Node result footer. */
export function nativeNodeResultCounts(command: string, output: string): { tests_total: number; tests_skipped: number; tests_passed: number; tests_failed: number } | null {
  if (analyzeVerifierIdentity(command)?.family !== 'node-test') return null
  const text = output.replace(/\r/g, '').replace(/\u001b\[[0-9;]*m/g, '')
  const line = (name: string) => `(?:#|ℹ)\\s+${name}\\s+(\\d+)[ \\t]*`
  const footer = new RegExp(`^${['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(line).join('\\n')}$`, 'gm')
  const match = [...text.matchAll(footer)].at(-1)
  if (!match || /^(?:#|ℹ)\s+(?:tests|suites|pass|fail|cancelled|skipped|todo)\s+/m.test(text.slice(match.index! + match[0].length))) return null
  const [total, , passed, failed, cancelled, skipped, todo] = match.slice(1).map(Number)
  if (!match.slice(1).every((value) => Number.isSafeInteger(Number(value))) || total !== passed! + failed! + cancelled! + skipped! + todo!) return null
  return { tests_total: total!, tests_skipped: skipped!, tests_passed: passed!, tests_failed: failed! }
}
