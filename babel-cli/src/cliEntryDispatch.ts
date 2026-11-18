import { desktopCapabilities, isDesktopCapabilityProbe } from './config/desktopCapabilities.js'

/** Machine-output contract requested by argv, if any. */
export function requestedMachineOutput(argv: readonly string[]): 'json' | 'ndjson' | null {
  if (argv.includes('--json')) return 'json'
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue
    const value = arg.startsWith('--output-format=')
      ? arg.slice('--output-format='.length)
      : arg === '--output-format'
        ? argv[i + 1]
        : undefined
    if (!value) continue
    const normalized = value.trim().toLowerCase()
    if (normalized === 'json') return 'json'
    if (normalized === 'jsonl' || normalized === 'ndjson' || normalized === 'stream-json') return 'ndjson'
  }
  return null
}

/**
 * A promised machine-readable failure must still produce machine-readable
 * stdout. stderr-only text on a `--json`/`--output-format` failure breaks
 * clean-profile automation consumers (UX-12).
 */
export function writeCliFailure(
  argv: readonly string[],
  message: string,
  write: (line: string) => void = (line) => process.stdout.write(line),
): void {
  const output = requestedMachineOutput(argv)
  if (output === 'json') {
    write(`${JSON.stringify({ status: 'error', message })}\n`)
    return
  }
  if (output === 'ndjson') {
    write(
      `${JSON.stringify({
        type: 'run_error',
        ts: new Date().toISOString(),
        status: 'EXECUTOR_HALTED',
        error: message,
      })}\n`,
    )
    return
  }
  process.stderr.write(`${message}\n`)
}

/** Canonical executable dispatch: capability probe before env bootstrap or cliMain. */
export async function dispatchExecutableCli(argv: string[] = process.argv): Promise<void> {
  if (isDesktopCapabilityProbe(argv)) {
    process.stdout.write(JSON.stringify(desktopCapabilities()) + '\n')
    return
  }
  const { startCli } = await import('./cliMain.js')
  try { await startCli(argv) }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Command failed.'
    writeCliFailure(argv, message)
    process.exitCode = 1
  }
}
