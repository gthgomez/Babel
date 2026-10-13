// License: Apache-2.0 — see LICENSE
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export function assertTrustedPublishingNpm(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!match) throw new Error('Cannot verify npm trusted publishing support')
  const [major, minor, patch] = match.slice(1).map(Number)
  if (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))) {
    throw new Error('npm trusted publishing requires npm 11.5.1 or later')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertTrustedPublishingNpm(execFileSync('npm', ['--version'], {encoding: 'utf8'}))
  console.log('npm trusted publishing toolchain verified')
}
