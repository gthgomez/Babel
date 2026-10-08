// License: Apache-2.0 — see LICENSE
import test from 'node:test'
import { parseWorkflow, commandCoverage } from '../ci-workflow-coverage.mjs'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, copyFileSync, rmSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

test('required native setup rejects a different executable before selecting project tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-native-rg-setup-'))
  try {
    const bin = join(root, 'bin'); mkdirSync(bin)
    // A real executable that accepts --version, with a deliberately wrong identity.
    copyFileSync(process.execPath,join(bin,process.platform === 'win32' ? 'rg.exe' : 'rg'))
    const script = fileURLToPath(new URL('../../babel-cli/scripts/run_ripgrep_qualification.mjs',import.meta.url))
    const result = spawnSync(process.execPath,[script,'native'],{cwd:root,encoding:'utf8',timeout:30000,
      env:{...process.env,PATH:bin}})
    assert.notEqual(result.status,0)
    assert.match(result.stderr,/Native qualification requires pinned ripgrep 15\.1\.0/)
    assert.ok(!result.stderr.includes('ENOENT'), 'Setup must fail before looking for test source')
  } finally { rmSync(root,{recursive:true,force:true}) }
})

test('required native setup rejects an absent executable before selecting project tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-native-rg-absent-'))
  try {
    const script = fileURLToPath(new URL('../../babel-cli/scripts/run_ripgrep_qualification.mjs',import.meta.url))
    const result = spawnSync(process.execPath,[script,'native'],{cwd:root,encoding:'utf8',timeout:30000,env:{...process.env,PATH:''}})
    assert.notEqual(result.status,0)
    assert.match(result.stderr,/Native qualification requires a real rg executable/)
    assert.ok(!result.stderr.includes('ENOENT'), 'Setup must fail before looking for test source')
  } finally { rmSync(root,{recursive:true,force:true}) }
})

function assertNativeGraph(workflow) {
  assert.deepEqual(commandCoverage(workflow, 'node scripts/run_ripgrep_qualification.mjs native'), {
    'ubuntu-latest': ['native-rg'], 'windows-latest': ['native-rg'],
  })
  assert.deepEqual(commandCoverage(workflow, 'node scripts/run_ripgrep_qualification.mjs fallback'), {
    'ubuntu-latest': ['native-rg'], 'windows-latest': ['native-rg'],
  })
  const setup = workflow.jobs['native-rg'].steps.find(step => step.run?.startsWith('pwsh -NoProfile -File tools/install-ci-ripgrep.ps1 '))
  assert.ok(setup, 'Pinned native setup must execute')
  assert.equal(setup.if, undefined)
  assert.equal(setup['continue-on-error'], undefined)
}
test('native and fallback qualification block both protected platform gates', () => {
  const workflow = parseWorkflow(readFileSync(new URL('../../.github/workflows/typecheck.yml', import.meta.url),'utf8'))
  assertNativeGraph(workflow)
  for (const change of [
    w => { w.jobs['native-rg'].strategy.matrix.os = ['ubuntu-latest'] },
    w => { w.jobs['native-rg'].steps.find(s => s.run?.endsWith('.mjs native')).if = 'false' },
    w => { w.jobs['native-rg'].steps.find(s => s.run?.endsWith('.mjs fallback'))['continue-on-error'] = true },
    w => { w.jobs['native-rg'].steps = w.jobs['native-rg'].steps.filter(s => !s.run?.includes('install-ci-ripgrep')) },
    w => { w.jobs['windows-portability'].needs = w.jobs['windows-portability'].needs.filter(n => n !== 'native-rg') },
    w => { w.jobs['linux-validation'].needs = w.jobs['linux-validation'].needs.filter(n => n !== 'native-rg') },
  ]) {
    const changed = structuredClone(workflow); change(changed)
    assert.throws(() => assertNativeGraph(changed))
  }
})
