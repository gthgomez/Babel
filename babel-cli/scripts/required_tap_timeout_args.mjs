// License: Apache-2.0 - see LICENSE
/**
 * Forward only the workflow's per-test timeout to the raw required suite.
 * The wrapper previously ignored it, so hung tests were bounded by the job
 * timeout rather than their configured limit.
 */
export function requiredTapTimeoutArgs(argv) {
  const forwarded = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (/^--test-timeout=\d+$/.test(value)) {
      forwarded.push(value)
      continue
    }
    if (value === '--test-timeout' && /^\d+$/.test(argv[index + 1] ?? '')) {
      forwarded.push(`--test-timeout=${argv[index + 1]}`)
      index += 1
    }
  }
  return [...new Set(forwarded)]
}
