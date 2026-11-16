import { desktopCapabilities, isDesktopCapabilityProbe } from './config/desktopCapabilities.js'

/** Only unqualified interactive invocations may skip the full command tree. */
export function isPlainInteractiveLaunch(argv: string[]): boolean {
  if (argv.length < 2 || !argv[1]) return false
  const executable = argv[1].split(/[\\/]/).pop()?.toLowerCase()
  if (['bl', 'bl.js', 'babel-lite', 'babel-lite.js'].includes(executable ?? '')) return false
  const args = argv.slice(2)
  return args.length === 0 || (args.length === 1 && ['interactive', 'app'].includes(args[0]!))
}

/** Canonical executable dispatch: capability probe before env bootstrap or cliMain. */
export async function dispatchExecutableCli(argv: string[] = process.argv): Promise<void> {
  if (isDesktopCapabilityProbe(argv)) {
    process.stdout.write(JSON.stringify(desktopCapabilities()) + '\n')
    return
  }
  try {
    if (isPlainInteractiveLaunch(argv)) {
      const { startPlainInteractiveCli } = await import('./cli/interactiveEntry.js')
      await startPlainInteractiveCli(argv)
    } else {
      const { startCli } = await import('./cliMain.js')
      await startCli(argv)
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Command failed.';
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify({ status: 'error', message })}\n`);
    else process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
