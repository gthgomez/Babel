import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const suite = process.argv[2] ?? 'chat-truth'
if (!['chat-truth', 'harness-runtime'].includes(suite)) {
  throw new Error(`Unsupported required TAP suite: ${suite}`)
}
const artifact = new URL(`../artifacts/${suite}/`, import.meta.url)
if (!existsSync(new URL('full.tap', artifact))) {
  console.log(`${suite} TAP inventory unavailable: suite did not start`)
  process.exit(0)
}
const tap = readFileSync(new URL('full.tap', artifact), 'utf8')
const lines = tap.split(/\r?\n/)
const parents = new Map()
const tests = []

for (let index = 0; index < lines.length; index++) {
  const line = lines[index]
  const header = /^(\s*)# Subtest: (.+)$/.exec(line)
  if (header) {
    const depth = header[1].length
    for (const prior of parents.keys()) if (prior >= depth) parents.delete(prior)
    parents.set(depth, header[2].trim())
    continue
  }
  const outcome = /^(\s*)(ok|not ok) \d+ - (.+)$/.exec(line)
  if (!outcome) continue
  const depth = outcome[1].length
  let kind = null
  let skipReason = /\s+# SKIP(?:\s+(.*))?$/.exec(outcome[3])?.[1]?.trim() ??
    (/\s+# SKIP(?:\s+.*)?$/.test(outcome[3]) ? 'unspecified' : null)
  for (let next = index + 1; next < Math.min(index + 16, lines.length); next++) {
    if (/^\s*\.\.\.\s*$/.test(lines[next])) break
    const type = /^\s*type: '([^']+)'\s*$/.exec(lines[next])
    if (type) kind = type[1]
    const skip = /^\s*# SKIP(?:\s+(.*))?\s*$/.exec(lines[next])
    if (skip) skipReason = skip[1]?.trim() || 'unspecified'
  }
  if (kind !== 'test') continue
  const name = outcome[3].replace(/\s+# SKIP(?:\s+.*)?$/, '').trim()
  const path = [...parents.entries()]
    .filter(([parentDepth]) => parentDepth < depth)
    .sort(([left], [right]) => left - right)
    .map(([, parentName]) => parentName)
  tests.push({
    id: [...path, name].join(' / '),
    result: skipReason !== null ? 'skipped' : outcome[2] === 'ok' ? 'passed' : 'failed',
    ...(skipReason !== null ? { skipReason } : {}),
  })
}

const summary = {
  schemaVersion: 1,
  suite,
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  testCount: tests.length,
  passed: tests.filter((item) => item.result === 'passed').length,
  failed: tests.filter((item) => item.result === 'failed').length,
  skipped: tests.filter((item) => item.result === 'skipped').length,
  tests,
}
writeFileSync(new URL('results.json', artifact), `${JSON.stringify(summary, null, 2)}\n`)
console.log(`${suite} TAP inventory: ${summary.testCount} tests, ` +
  `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`)
