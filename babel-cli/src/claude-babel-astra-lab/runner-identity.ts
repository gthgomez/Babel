import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest } from './comparison-contract.js'

/** Observe the actual checkout and retain task-owned runner bytes, even if dirty. */
export function runnerIdentity(): { sha: string; sourceDigest: string; sources: Record<string, string> } {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim()
  const sources: Record<string, string> = {}
  for (const name of ['comparison-contract', 'comparison-runner', 'comparison-report', 'frozen-evaluator', 'runner-identity']) {
    const path = `babel-cli/src/claude-babel-astra-lab/${name}.ts`
    sources[path] = readFileSync(resolve(root, path), 'utf8')
  }
  const fixture = 'babel-cli/src/fixtures/claude-babel-astra-lab/fixtures.ts'
  sources[fixture] = readFileSync(resolve(root, fixture), 'utf8')
  return { sha, sourceDigest: digest(sources), sources }
}
