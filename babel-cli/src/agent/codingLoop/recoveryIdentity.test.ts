import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { recoveryTargetIdentity, recoveryWorkspaceRevision } from './recoveryIdentity.js'

test('candidate binding changes with tracked edits and untracked content', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-recovery-revision-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true })
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'Foo.ts'), 'export const answer = 1\n')
    execFileSync('git', ['add', 'src/Foo.ts'], { cwd: root, windowsHide: true })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], {
      cwd: root, windowsHide: true,
    })
    const indexed = recoveryWorkspaceRevision(root)
    assert.ok(indexed)
    writeFileSync(join(root, 'src', 'Foo.ts'), 'export const answer = 2\n')
    const edited = recoveryWorkspaceRevision(root)
    assert.ok(edited)
    assert.notEqual(edited, indexed)
    writeFileSync(join(root, 'src', 'Foo.ts'), 'export const answer = 1\n')
    assert.equal(recoveryWorkspaceRevision(root), indexed)
    writeFileSync(join(root, 'new.ts'), 'first\n')
    const untracked = recoveryWorkspaceRevision(root)
    assert.ok(untracked)
    assert.notEqual(untracked, indexed)
    writeFileSync(join(root, 'new.ts'), 'second\n')
    assert.notEqual(recoveryWorkspaceRevision(root), untracked)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('target identity resolves dot segments and rejects an escaping symlink', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-recovery-root-'))
  const external = mkdtempSync(join(tmpdir(), 'babel-recovery-external-'))
  try {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'Foo.ts'), 'content')
    assert.equal(recoveryTargetIdentity(root, 'src/./Foo.ts'), 'src/Foo.ts')
    if (existsSync(join(root, 'src', 'foo.ts'))) {
      assert.equal(recoveryTargetIdentity(root, 'src/foo.ts'), 'src/Foo.ts')
    } else {
      writeFileSync(join(root, 'src', 'foo.ts'), 'different')
      assert.equal(recoveryTargetIdentity(root, 'src/foo.ts'), 'src/foo.ts')
    }
    assert.equal(recoveryTargetIdentity(root, '../outside.ts'), null)
    try {
      symlinkSync(external, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.diagnostic('symlink creation is unavailable on this host')
        return
      }
      throw error
    }
    writeFileSync(join(external, 'outside.ts'), 'external')
    assert.equal(recoveryTargetIdentity(root, 'escape/outside.ts'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
  }
})

test('an unborn Git workspace receives a physical content binding and later commit changes it', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-recovery-unborn-content-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true })
    writeFileSync(join(root, 'solution.py'), 'def answer(): return 0\n')
    execFileSync('git', ['add', '--', 'solution.py'], { cwd: root, windowsHide: true })
    const unborn = recoveryWorkspaceRevision(root)
    assert.ok(unborn, 'a physically captured unborn repository is a valid content-only candidate')
    writeFileSync(join(root, 'solution.py'), 'def answer(): return 1\n')
    const changed = recoveryWorkspaceRevision(root)
    assert.ok(changed)
    assert.notEqual(changed, unborn, 'content edits invalidate an unborn candidate')
    execFileSync('git', ['add', '--', 'solution.py'], { cwd: root, windowsHide: true })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'first'], {
      cwd: root, windowsHide: true,
    })
    const committed = recoveryWorkspaceRevision(root)
    assert.ok(committed)
    assert.notEqual(committed, changed, 'the Git identity remains part of the binding once HEAD exists')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const captureFailure of ['oversized input', 'credential metadata', 'non-Git workspace', 'escaping symlink'] as const) {
  test(`${captureFailure} cannot produce a recovery workspace revision`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'babel-recovery-capture-truth-'))
    try {
      writeFileSync(join(root, 'source.ts'), 'export const value = 1\n')
      if (captureFailure !== 'non-Git workspace') {
        execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true })
        execFileSync('git', ['add', 'source.ts'], { cwd: root, windowsHide: true })
        execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], {
          cwd: root, windowsHide: true,
        })
        assert.ok(recoveryWorkspaceRevision(root), 'committed fixture supplies positive physical capture')
      }
      if (captureFailure === 'oversized input') writeFileSync(join(root, 'large.bin'), Buffer.alloc(1_000_001))
      if (captureFailure === 'credential metadata') {
        writeFileSync(join(root, '.env'), '')
        execFileSync('git', ['add', '.env'], { cwd: root, windowsHide: true })
      }
      if (captureFailure === 'escaping symlink') {
        const external = mkdtempSync(join(tmpdir(), 'babel-recovery-external-'))
        t.after(() => rmSync(external, { recursive: true, force: true }))
        writeFileSync(join(external, 'outside.py'), 'outside\n')
        try { symlinkSync(external, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir') }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EPERM') {
            t.diagnostic('symlink creation is unavailable on this host')
            return
          }
          throw error
        }
      }
      assert.equal(recoveryWorkspaceRevision(root), null, 'unknown physical capture cannot grant a usable recovery revision')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
