// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { consumerEnvironment } from './consumer_environment.mjs'
import {
  installPathClass,
  runtimeProjectPathClass,
  validateAsciiInstallControlPrefix,
} from './consumer_install_path_qualification.mjs'

test('mandatory primary paths use Unicode install prefix and unicode+space runtime project', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'babel consumer é-'))
  try {
    const prefixUnicode = join(scratch, 'install prefix é')
    const project = join(scratch, 'project 空 space')
    assert.equal(installPathClass(resolve(prefixUnicode)), 'unicode_install_prefix')
    assert.equal(runtimeProjectPathClass(resolve(project)), 'unicode_project_with_space')
    const env = consumerEnvironment(process.env, scratch)
    assert.match(resolve(env.BABEL_CONFIG_DIR), /config area ü/)
    assert.equal(resolve(env.TMPDIR), resolve(scratch))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('ASCII dirname nested under Unicode qualification scratch is not a valid install control', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'babel consumer é-'))
  try {
    const invalidControl = join(scratch, 'install-prefix-control')
    assert.equal(installPathClass(resolve(invalidControl)), 'unicode_install_prefix')
    assert.throws(() => validateAsciiInstallControlPrefix(invalidControl), {
      code: 'INVALID_ASCII_INSTALL_CONTROL_PATH',
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('genuine Windows diagnostic control uses ASCII-only full absolute install path', () => {
  const scratchAscii = mkdtempSync(join(tmpdir(), 'babel-consumer-'))
  try {
    const control = join(scratchAscii, 'install-prefix')
    const resolved = validateAsciiInstallControlPrefix(control)
    assert.equal(installPathClass(resolved), 'ascii_install_prefix_control')
    assert.doesNotMatch(resolved, /[^\x00-\x7f]|\s/)
  } finally {
    rmSync(scratchAscii, { recursive: true, force: true })
  }
})
