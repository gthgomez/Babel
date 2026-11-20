#!/usr/bin/env node
// License: Apache-2.0 - see LICENSE

/** Extract and validate a per-test timeout from the wrapper's extra arguments. */
export function requiredTapTimeoutArgs(argv) {
  const args = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--test-timeout') {
      const value = argv[index + 1]
      if (value === undefined || !/^\d+$/.test(value)) continue
      args.add(`--test-timeout=${value}`)
      index += 1
      continue
    }
    if (/^--test-timeout=\d+$/.test(arg)) args.add(arg)
  }
  return [...args]
}

/**
 * Insert Node's per-test timeout before the `--test` selector. Options placed
 * after the positional test files are ignored (and can disturb the runner), so
 * the flag must precede the flag it qualifies.
 */
export function requiredTapCommand(rawCommand, timeoutArgs) {
  if (timeoutArgs.length === 0) return rawCommand
  const parts = rawCommand.trim().split(/\s+/)
  const testIndex = parts.indexOf('--test')
  if (testIndex < 0) return rawCommand
  return [
    ...parts.slice(0, testIndex),
    ...timeoutArgs,
    ...parts.slice(testIndex),
  ].join(' ')
}
