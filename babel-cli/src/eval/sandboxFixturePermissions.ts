import { chmodSync, lstatSync, readdirSync } from 'node:fs'

/**
 * Generated, secret-free fixture trees must be traversable/readable by the
 * unprivileged user inside the read-only Docker sandbox, regardless of umask.
 */
export function normalizeSandboxFixturePermissions(root: string): void {
  const visit = (path: string): void => {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) throw new Error('Generated sandbox fixture contains a symbolic link')
    if (info.isDirectory()) {
      chmodSync(path, 0o755)
      for (const entry of readdirSync(path)) visit(`${path}/${entry}`)
    } else if (info.isFile()) {
      chmodSync(path, (info.mode & 0o111) !== 0 ? 0o755 : 0o644)
    } else {
      throw new Error('Generated sandbox fixture contains an unsupported filesystem object')
    }
  }
  visit(root)
}
