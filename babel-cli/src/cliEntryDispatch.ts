import { desktopCapabilities, isDesktopCapabilityProbe } from './config/desktopCapabilities.js'

/** Canonical executable dispatch: capability probe before env bootstrap or cliMain. */
export async function dispatchExecutableCli(argv: string[] = process.argv): Promise<void> {
  if (isDesktopCapabilityProbe(argv)) {
    process.stdout.write(JSON.stringify(desktopCapabilities()) + '\n')
    return
  }
  const { startCli } = await import('./cliMain.js')
  try { await startCli(argv) }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Command failed.';
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify({ status: 'error', message })}\n`);
    else process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
