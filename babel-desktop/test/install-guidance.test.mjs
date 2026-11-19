// W11 UX-16: install guidance must name the version it describes and must not
// present the older release's plaintext private credentials as current-source
// behavior. The release ZIP itself is only qualified on Windows; this test
// guards the source documentation that ships into the next package.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const install = readFileSync(new URL('../docs/INSTALL-WINDOWS.md', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

test('Windows install guide distinguishes the older 0.1.3 release from current-source storage', () => {
  const versionNote = install.split('\n').find(line => line.startsWith('> **Version note:**'))
  assert.ok(versionNote, 'the guide must open with a version note')
  assert.match(versionNote, /0\.1\.3/)
  assert.match(versionNote, /older/i)
  assert.match(versionNote, /plaintext/i)
  assert.match(versionNote, /current-source|current source/i)
})

test('current private credentials are documented as OS-protected with no plaintext fallback', () => {
  assert.match(install, /Private keys use Windows-protected storage under the profile/i)
  assert.match(install, /There is no plaintext fallback when OS protection is unavailable/i)
  assert.match(install, /Legacy-key migration retains the original private plaintext file for recovery/i)
  // The only plaintext private-storage claims belong to the historical note
  // or the explicit legacy recovery path, never the current default.
  const currentClaims = install.split('\n')
    .filter(line => !line.startsWith('> **Version note:**'))
    .filter(line => /private (?:provider )?key[s]? (?:use|are)|private credential/i.test(line))
  assert.ok(currentClaims.every(line => !/plaintext storage/i.test(line)), 'current private keys must not be described as plaintext')
})

test('desktop README marks current credential behavior as source behavior that may differ from a download', () => {
  const note = readme.split('\n').find(line => line.startsWith('> **Version note:**'))
  assert.ok(note, 'the README must carry a version note')
  assert.match(note, /current source/i)
  assert.match(note, /may differ from an installer you download/i)
  assert.match(note, /OS-protected credential storage/i)
})
