import assert from 'node:assert/strict'

/** Matrix/race probe scripts must exit 0 with empty stderr. */
export type NativeChildMode = 'probe' | 'oracle'

const ORACLE_EXITS = new Set([0, 1, 2])

/**
 * Caller-specific native PowerShell exit expectations.
 * Probes: status 0 only. Oracle: contract exits 0 (pass), 1 (fail), 2 (unsupported).
 */
export function assertNativeChildExit(
  mode: NativeChildMode,
  status: number | null,
  stderr: string,
  stdout: string,
): void {
  const detail = `stderr:\n${stderr}\nstdout:\n${stdout}`
  if (mode === 'probe') {
    assert.equal(
      status,
      0,
      `native PowerShell probe exit ${status ?? 'unknown'}\n${detail}`,
    )
    assert.equal(stderr ?? '', '', `native PowerShell probe stderr must be empty:\n${stderr}`)
    return
  }
  assert.ok(
    status !== null && ORACLE_EXITS.has(status),
    `native PowerShell oracle exit must be 0, 1, or 2; got ${status ?? 'unknown'}\n${detail}`,
  )
}

export function oracleExitContract(): readonly number[] {
  return [0, 1, 2]
}
