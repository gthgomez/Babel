import { desktopCapabilities, isDesktopCapabilityProbe } from './config/desktopCapabilities.js'

/** Canonical executable dispatch: capability probe before env bootstrap or cliMain. */
export async function dispatchExecutableCli(argv: string[] = process.argv): Promise<void> {
  if (isDesktopCapabilityProbe(argv)) {
    process.stdout.write(JSON.stringify(desktopCapabilities()) + '\n')
    return
  }
  const { startCli } = await import('./cliMain.js')
  await startCli(argv)
}
