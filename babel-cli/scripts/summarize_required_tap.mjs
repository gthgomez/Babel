import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FOOTER_FIELDS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']

function countFooterFields(lines) {
  const footer = {}
  for (const field of FOOTER_FIELDS) {
    const expression = new RegExp(`^# ${field} (\\d+(?:\\.\\d+)?)\\s*$`)
    const matches = lines.map((line) => expression.exec(line)).filter(Boolean)
    if (matches.length === 1) footer[field] = Number(matches[0][1])
  }
  return footer
}

export function parseRequiredTapInventory(tap, suite) {
  const errors = []
  const tests = []
  if (tap === null) {
    return {
      schemaVersion: 2, suite, status: 'not_started', errors: ['missing_full_tap'],
      testCount: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0, tests,
    }
  }

  const lines = tap.split(/\r?\n/)
  const tapHeaderIndexes = lines.flatMap((line, index) => line === 'TAP version 13' ? [index] : [])
  if (tapHeaderIndexes.length !== 1) errors.push('missing_or_duplicate_tap_version_13')
  const outcomes = []
  const parents = new Map()
  let nextParentId = 1

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const header = /^(\s*)# Subtest: (.+)$/.exec(line)
    if (header) {
      const depth = header[1].length
      for (const prior of parents.keys()) if (prior >= depth) parents.delete(prior)
      parents.set(depth, { id: nextParentId++, name: header[2].trim() })
      continue
    }

    const outcome = /^(\s*)(ok|not ok) (\d+) - (.+)$/.exec(line)
    if (!outcome) continue
    const depth = outcome[1].length
    let kind = null
    const inlineSkip = /\s+# SKIP(?:\s+(.*))?$/.exec(outcome[4])
    let skipReason = inlineSkip ? inlineSkip[1]?.trim() || 'unspecified' : null
    const idSuffix = outcome[4].replace(/\s+# (?:SKIP|TODO)(?:\s+.*)?$/, '').trim()
    let todoReason = null
    const todo = /\s+# TODO(?:\s+(.*))?$/.exec(outcome[4])
    if (todo) todoReason = todo[1]?.trim() || 'unspecified'

    for (let next = index + 1; next < lines.length; next++) {
      if (/^\s*(?:ok|not ok) \d+ - /.test(lines[next])) break
      if (/^\s*\.\.\.\s*$/.test(lines[next])) break
      const type = /^\s*type: '([^']+)'\s*$/.exec(lines[next])
      if (type) kind = type[1]
      const skip = /^\s*# SKIP(?:\s+(.*))?\s*$/.exec(lines[next])
      if (skip) skipReason = skip[1]?.trim() || 'unspecified'
      const diagnosticTodo = /^\s*# TODO(?:\s+(.*))?\s*$/.exec(lines[next])
      if (diagnosticTodo) todoReason = diagnosticTodo[1]?.trim() || 'unspecified'
    }

    if (kind !== 'test' && kind !== 'suite') {
      errors.push(`outcome_${outcome[3]}_missing_or_invalid_type`)
      continue
    }
    const path = [...parents.entries()]
      .filter(([parentDepth]) => parentDepth < depth)
      .sort(([left], [right]) => left - right)
      .map(([, parent]) => parent.name)
    const scopeKey = [...parents.entries()]
      .filter(([parentDepth]) => parentDepth < depth)
      .sort(([left], [right]) => left - right)
      .map(([, parent]) => parent.id)
      .join('/')
    const id = [...path, idSuffix].join(' / ')
    const result = {
      id,
      result: todoReason !== null ? 'todo' : skipReason !== null ? 'skipped' :
        outcome[2] === 'ok' ? 'passed' : 'failed',
      ...(skipReason !== null ? { skipReason } : {}),
      ...(todoReason !== null ? { todoReason } : {}),
    }
    const record = { depth, kind, sequence: Number(outcome[3]), scopeKey, outcome: outcome[2], result }
    outcomes.push(record)
    if (kind === 'test') tests.push(result)
  }

  const planMatches = lines.flatMap((line) => {
    const match = /^(\s*)1\.\.(\d+)\s*$/.exec(line)
    return match ? [{ depth: match[1].length, count: Number(match[2]) }] : []
  })
  const rootPlans = planMatches.filter((plan) => plan.depth === 0)
  if (rootPlans.length !== 1) errors.push('missing_or_duplicate_root_plan')
  const footer = countFooterFields(lines)
  const footerErrorsAtStart = errors.length
  for (const field of FOOTER_FIELDS) {
    if (!(field in footer)) errors.push(`missing_or_duplicate_footer_${field}`)
  }
  if (rootPlans.length !== 1 || errors.length !== footerErrorsAtStart) {
    errors.push('missing_terminal_footer')
  }
  if (Object.keys(footer).length === FOOTER_FIELDS.length) {
    if (tapHeaderIndexes[0] >= lines.findIndex((line) => /^\s*(?:ok|not ok) \d+ - /.test(line))) {
      errors.push('tap_header_after_outcomes')
    }
    const rootOutcomes = outcomes.filter((item) => item.depth === 0).length
    if (rootPlans.length === 1 && rootPlans[0].count !== rootOutcomes) errors.push('root_plan_outcome_mismatch')
    const observed = {
      tests: tests.length,
      suites: outcomes.filter((item) => item.kind === 'suite').length,
      pass: tests.filter((item) => item.result === 'passed').length,
      fail: tests.filter((item) => item.result === 'failed').length,
      cancelled: footer.cancelled,
      skipped: tests.filter((item) => item.result === 'skipped').length,
      pending: tests.filter((item) => item.result === 'todo').length,
    }
    for (const [field, count] of Object.entries(observed)) {
      const footerField = field === 'pending' ? 'todo' : field
      if (footer[footerField] !== count) errors.push(`inventory_footer_mismatch_${footerField}`)
    }
    if (tests.length === 0) errors.push('empty_test_inventory')
  }

  const sequenceByScope = new Map()
  for (const item of outcomes) {
    const previous = sequenceByScope.get(item.scopeKey) ?? 0
    if (item.sequence !== previous + 1) errors.push('invalid_tap_sequence')
    sequenceByScope.set(item.scopeKey, item.sequence)
  }

  const ids = new Set()
  for (const item of tests) {
    if (ids.has(item.id)) errors.push('duplicate_test_id')
    ids.add(item.id)
  }
  if (footer.cancelled > 0) errors.push('cancelled_tests')
  if (footer.todo > 0) errors.push('todo_tests')

  const failed = tests.filter((item) => item.result === 'failed').length
  const hasExecutionFailure = failed > 0 || (footer.fail ?? 0) > 0 || (footer.cancelled ?? 0) > 0 || (footer.todo ?? 0) > 0
  const hasTerminal = rootPlans.length === 1 && Object.keys(footer).length === FOOTER_FIELDS.length
  const status = hasExecutionFailure || errors.includes('duplicate_test_id') || errors.includes('invalid_tap_sequence') ? 'failed' :
    errors.length > 0 || !hasTerminal ? 'incomplete' : 'complete'

  return {
    schemaVersion: 2,
    suite,
    status,
    errors: [...new Set(errors)],
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    testCount: tests.length,
    passed: tests.filter((item) => item.result === 'passed').length,
    failed,
    cancelled: footer.cancelled ?? 0,
    skipped: tests.filter((item) => item.result === 'skipped').length,
    pendingCount: tests.filter((item) => item.result === 'todo').length,
    footer: Object.keys(footer).length > 0 ? footer : undefined,
    tests,
  }
}

export function summarizeRequiredTap(suite, artifactDirectory) {
  const directory = resolve(artifactDirectory)
  mkdirSync(directory, { recursive: true })
  const tapPath = resolve(directory, 'full.tap')
  const tap = existsSync(tapPath) ? readFileSync(tapPath, 'utf8') : null
  const summary = parseRequiredTapInventory(tap, suite)
  const selectionPath = resolve(directory, 'selection.json')
  if (!existsSync(selectionPath)) {
    summary.errors.push('missing_selected_file_manifest')
  } else {
    try {
      const selectionText = readFileSync(selectionPath, 'utf8')
      const selection = JSON.parse(selectionText)
      const files = Array.isArray(selection.files) ? selection.files : []
      if (selection.schemaVersion !== 1 || selection.suite !== suite || files.length === 0 ||
          typeof selection.nodeVersion !== 'string' || typeof selection.platform !== 'string' ||
          typeof selection.arch !== 'string' || !/^[a-f0-9]{64}$/.test(selection.packageScriptSha256 ?? '')) {
        summary.errors.push('invalid_selected_file_manifest')
      }
      const paths = new Set()
      for (const file of files) {
        if (typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split(/[\\/]/).includes('..') ||
            !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || paths.has(file.path)) {
          summary.errors.push('invalid_or_duplicate_selected_file')
          continue
        }
        paths.add(file.path)
      }
      summary.selectedFileCount = files.length
      summary.selectionManifestSha256 = createHash('sha256').update(selectionText).digest('hex')
      summary.selection = selection
      if (selection.platform !== process.platform || selection.arch !== process.arch || selection.nodeVersion !== process.version) {
        summary.errors.push('selection_runtime_mismatch')
      }
    } catch {
      summary.errors.push('malformed_selected_file_manifest')
    }
  }
  summary.errors = [...new Set(summary.errors)]
  if (summary.errors.length > 0 && !['failed', 'not_started'].includes(summary.status)) {
    summary.status = 'incomplete'
  }
  writeFileSync(resolve(directory, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}

const suite = process.argv[2] ?? 'chat-truth'
if (!['chat-truth', 'harness-runtime'].includes(suite)) {
  throw new Error(`Unsupported required TAP suite: ${suite}`)
}
const artifactDirectory = process.argv[3] ?? fileURLToPath(new URL(`../artifacts/${suite}/`, import.meta.url))
const summary = summarizeRequiredTap(suite, artifactDirectory)
console.log(`${suite} TAP inventory ${summary.status}: ${summary.testCount} tests, ` +
  `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`)
if (summary.errors.length > 0) console.error(`${suite} TAP inventory errors: ${summary.errors.join(', ')}`)
if (summary.status !== 'complete') process.exitCode = 1
