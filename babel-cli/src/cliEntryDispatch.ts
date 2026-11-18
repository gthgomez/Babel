import { readFileSync } from 'node:fs'

import { desktopCapabilities, isDesktopCapabilityProbe } from './config/desktopCapabilities.js'

/** Only a bare version probe may skip the full command tree. */
export function isVersionProbe(argv: readonly string[]): boolean {
  return argv.length === 3 && (argv[2] === '--version' || argv[2] === '-V')
}

/**
 * Print the package version without loading the command graph.
 *
 * `babel --version` is a metadata probe; importing every command module for it
 * cost thousands of module loads and ~2s cold (UX-19).
 *
 * @param argv - Raw process argv.
 * @returns True when the probe was handled.
 */
export function printVersionProbe(argv: readonly string[]): boolean {
  if (!isVersionProbe(argv)) return false
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown }
  process.stdout.write(`${String(manifest.version ?? 'unknown')}\n`)
  return true
}

/** Canonical executable dispatch: capability probe before env bootstrap or cliMain. */
export async function dispatchExecutableCli(argv: string[] = process.argv): Promise<void> {
  if (isDesktopCapabilityProbe(argv)) {
    process.stdout.write(JSON.stringify(desktopCapabilities()) + '\n')
    return
  }
  if (printVersionProbe(argv)) return
  const { startCli } = await import('./cliMain.js')
  try { await startCli(argv) }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Command failed.';
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify({ status: 'error', message })}\n`);
    else process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
