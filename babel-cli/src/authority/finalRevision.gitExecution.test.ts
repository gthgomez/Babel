import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { evaluateFinalRevisionWitness } from './finalRevision.js'
import { decidePipelineFinalCompletion } from '../pipeline/finalCompletion.js'

function gitEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
  }
}

function repo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'babel-final-revision-exec-'))
  const env = gitEnv(root)
  execFileSync('git', ['init', '-q'], { cwd: root, env, windowsHide: true })
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root, env, windowsHide: true })
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root, env, windowsHide: true })
  writeFileSync(join(root, 'file.txt'), 'needle\n')
  writeFileSync(join(root, 'file.bin'), 'binary-needle\n')
  writeFileSync(join(root, '.gitattributes'), '*.bin diff=custom\n')
  execFileSync('git', ['add', '.'], { cwd: root, env, windowsHide: true })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root, env, windowsHide: true })
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const GREEN = { tool: 'test_run' as const, target: 'npm test', exit_code: 0 }

test('git grep pager executes on the host and the witness is stale', () => {
  const { root, cleanup } = repo()
  try {
    const marker = join(root, 'PAGER_RAN')
    const pager = join(root, 'pager.sh')
    writeFileSync(pager, `#!/bin/sh\n: > "${marker}"\ncat >/dev/null\n`)
    chmodSync(pager, 0o755)
    execFileSync('git', ['grep', `-O${pager}`, 'needle', '--', '.'], {
      cwd: root, env: gitEnv(root), stdio: 'ignore', windowsHide: true,
    })
    assert.equal(existsSync(marker), true, 'the pager must actually execute')
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [GREEN, { tool: 'shell_exec', target: `git grep -O${pager} needle -- .`, exit_code: 0 }],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'stale')
  } finally {
    cleanup()
  }
})

test('git show --textconv executes the configured filter and the witness is stale', () => {
  const { root, cleanup } = repo()
  try {
    const marker = join(root, 'TEXTCONV_RAN')
    const converter = join(root, 'textconv.sh')
    writeFileSync(converter, `#!/bin/sh\n: > "${marker}"\ncat\n`)
    chmodSync(converter, 0o755)
    const env = gitEnv(root)
    execFileSync('git', ['config', 'diff.custom.textconv', converter], { cwd: root, env, windowsHide: true })
    execFileSync('git', ['show', '--textconv', 'HEAD:file.bin'], { cwd: root, env, stdio: 'ignore', windowsHide: true })
    assert.equal(existsSync(marker), true, 'the textconv filter must actually execute')
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [GREEN, { tool: 'shell_exec', target: 'git show --textconv HEAD', exit_code: 0 }],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'stale')
  } finally {
    cleanup()
  }
})

test('git cat-file --filters executes the configured filter and the witness is stale', () => {
  const { root, cleanup } = repo()
  try {
    const marker = join(root, 'FILTER_RAN')
    const filter = join(root, 'filter.sh')
    writeFileSync(filter, `#!/bin/sh\n: > "${marker}"\ncat\n`)
    chmodSync(filter, 0o755)
    writeFileSync(join(root, '.gitattributes'), '*.txt filter=up\n')
    const env = gitEnv(root)
    execFileSync('git', ['config', 'filter.up.smudge', filter], { cwd: root, env, windowsHide: true })
    execFileSync('git', ['config', 'filter.up.clean', filter], { cwd: root, env, windowsHide: true })
    execFileSync('git', ['add', '.gitattributes'], { cwd: root, env, windowsHide: true })
    execFileSync('git', ['commit', '-qm', 'attributes'], { cwd: root, env, windowsHide: true })
    execFileSync('git', ['cat-file', '--filters', 'HEAD:file.txt'], { cwd: root, env, stdio: 'ignore', windowsHide: true })
    assert.equal(existsSync(marker), true, 'the filter must actually execute')
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [GREEN, { tool: 'shell_exec', target: 'git cat-file --filters HEAD:file.txt', exit_code: 0 }],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'stale')
  } finally {
    cleanup()
  }
})


test('repo-configured diff.external escapes argv and downgrades to effect-unproven', () => {
  const { root, cleanup } = repo()
  try {
    writeFileSync(join(root, 'file.txt'), 'changed\n')
    const marker = join(root, 'DIFF_EXTERNAL_RAN')
    const external = join(root, 'external-diff.sh')
    writeFileSync(external, `#!/bin/sh\n: > "${marker}"\nexit 0\n`)
    chmodSync(external, 0o755)
    const env = gitEnv(root)
    execFileSync('git', ['config', 'diff.external', external], { cwd: root, env, windowsHide: true })
    execFileSync('git', ['diff'], { cwd: root, env, stdio: 'ignore', windowsHide: true })
    assert.equal(existsSync(marker), true, 'configured diff.external must execute')
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [
        { tool: 'shell_exec', target: `git config diff.external ${external}`, exit_code: 0 },
        GREEN,
        { tool: 'shell_exec', target: 'git diff', exit_code: 0 },
      ],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'unverified')
    assert.equal(witness.reason, 'effect_unproven:config_capable_git')
    const final = decidePipelineFinalCompletion({
      mode: 'deep', status: 'COMPLETE', projectRoot: root, requiredVerifierCommands: ['npm test'],
      toolCallLog: [
        { step: 1, tool: 'shell_exec', target: `git config diff.external ${external}`, exit_code: 0, stdout: '', stderr: '', verified: true },
        { step: 2, tool: 'test_run', target: 'npm test', exit_code: 0, stdout: 'ok', stderr: '', verified: true },
        { step: 3, tool: 'shell_exec', target: 'git diff', exit_code: 0, stdout: '', stderr: '', verified: true },
      ],
    })
    assert.equal(final.status, 'COMPLETE')
    assert.equal(final.decision?.finalOutcome, 'UNVERIFIED_PATCH')
    assert.match(final.condition ?? '', /effect-unproven/)
  } finally {
    cleanup()
  }
})

test('hardened diff invocation disables diff.external and stays verified', () => {
  const { root, cleanup } = repo()
  try {
    writeFileSync(join(root, 'file.txt'), 'changed\n')
    const marker = join(root, 'DIFF_EXTERNAL_RAN')
    const external = join(root, 'external-diff.sh')
    writeFileSync(external, `#!/bin/sh\n: > "${marker}"\nexit 0\n`)
    chmodSync(external, 0o755)
    const env = gitEnv(root)
    execFileSync('git', ['config', 'diff.external', external], { cwd: root, env, windowsHide: true })
    execFileSync('git', ['-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv'], {
      cwd: root, env, stdio: 'ignore', windowsHide: true,
    })
    assert.equal(existsSync(marker), false, '--no-ext-diff must forbid the configured driver')
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [GREEN, { tool: 'shell_exec', target: 'git -c core.fsmonitor=false diff --no-ext-diff --no-textconv', exit_code: 0 }],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'verified')
  } finally {
    cleanup()
  }
})

test('repo-configured fsmonitor executes on git status; hardening disables it', () => {
  const { root, cleanup } = repo()
  try {
    const marker = join(root, 'FSMONITOR_RAN')
    const hook = join(root, 'fsmonitor.sh')
    writeFileSync(hook, `#!/bin/sh\n: > "${marker}"\nprintf '{}'\n`)
    chmodSync(hook, 0o755)
    const env = gitEnv(root)
    execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: root, env, windowsHide: true })
    execFileSync('git', ['status'], { cwd: root, env, stdio: 'ignore', windowsHide: true })
    assert.equal(existsSync(marker), true, 'configured fsmonitor must execute')
    const plain = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [GREEN, { tool: 'shell_exec', target: 'git status', exit_code: 0 }],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(plain.status, 'unverified')
    assert.equal(plain.reason, 'effect_unproven:config_capable_git')
    rmSync(marker, { force: true })
    execFileSync('git', ['-c', 'core.fsmonitor=false', 'status'], { cwd: root, env, stdio: 'ignore', windowsHide: true })
    assert.equal(existsSync(marker), false, '-c core.fsmonitor=false must disable the hook')
    const hardened = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [GREEN, { tool: 'shell_exec', target: 'git -c core.fsmonitor=false status', exit_code: 0 }],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(hardened.status, 'verified')
  } finally {
    cleanup()
  }
})
