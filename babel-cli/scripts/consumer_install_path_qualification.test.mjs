// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { consumerEnvironment } from './consumer_environment.mjs'
import {
  buildInstallPathComparison,
  installPathClass,
  npmInstallProbe,
  runtimeProjectPathClass,
  validateAsciiInstallControlPrefix,
} from './consumer_install_path_qualification.mjs'

test('installPathClass and runtimeProjectPathClass distinguish unicode install vs control paths', () => {
  assert.equal(installPathClass('/tmp/install prefix é'), 'unicode_install_prefix')
  assert.equal(installPathClass('/tmp/install-prefix-control'), 'ascii_install_prefix_control')
  assert.equal(
    installPathClass('/tmp/babel consumer é-abc/install-prefix-control'),
    'unicode_install_prefix',
    'full install prefix path must be classified, not leaf dirname alone',
  )
  assert.equal(runtimeProjectPathClass('/tmp/project 空 space'), 'unicode_project_with_space')
})

test('validateAsciiInstallControlPrefix rejects Unicode scratch ancestors', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'babel consumer é-'))
  assert.throws(() => validateAsciiInstallControlPrefix(join(scratch, 'install-prefix')), {
    code: 'INVALID_ASCII_INSTALL_CONTROL_PATH',
  })
})

test('npmInstallProbe returns structured failure without throwing on missing artifact', () => {
  assert.ok(process.env.npm_execpath, 'npm_execpath required for probe behavior test')
  const scratch = mkdtempSync(join(tmpdir(), 'babel consumer é-'))
  const project = join(scratch, 'project 空 space')
  mkdirSync(project, { recursive: true })
  const prefix = join(scratch, 'install prefix é')
  const env = consumerEnvironment(process.env, scratch)
  const probe = npmInstallProbe({
    installPrefix: prefix,
    artifact: join(scratch, 'missing-consumer-artifact.tgz'),
    npmCli: process.env.npm_execpath,
    project,
    env,
    scratch,
    phase: 'behavior_test_probe',
    timeoutMs: 60_000,
  })
  assert.equal(probe.install_path_class, 'unicode_install_prefix')
  assert.equal(probe.success, false)
  assert.ok(probe.status === 1 || probe.error || probe.stderr_tail.length > 0)
})

test('buildInstallPathComparison marks outcomes as not equivalent qualifications', () => {
  const comparison = buildInstallPathComparison({
    unicodeProbe: { success: false, install_path_class: 'unicode_install_prefix', phase: 'u' },
    asciiProbe: { success: true, install_path_class: 'ascii_install_prefix_control', phase: 'a' },
    baselineEvidence: 'fixtures/consumer-artifact/evidence/windows-ci-42843069423-etimedout-baseline.json',
  })
  assert.ok(comparison.not_equivalent_to.includes('consumer_environment_unicode_config_only'))
  assert.equal(comparison.unicode_path.success, false)
  assert.equal(comparison.ascii_control.success, true)
})
