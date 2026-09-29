import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertTrustedReviewCodePath, assertTrustedReviewInstallation } from './trustedReviewInstallation.js'

test('trusted review installation must be clean and rooted in the candidate base', () => {
  const root = mkdtempSync(join(tmpdir(), 'trusted-review-installation-'))
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  try {
    git(['init', '-q'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'source.txt'), 'trusted')
    git(['add', 'source.txt'])
    git(['commit', '-qm', 'trusted'])
    const trusted = git(['rev-parse', 'HEAD'])
    assert.equal(assertTrustedReviewInstallation(root, trusted), trusted)
    assert.equal(assertTrustedReviewInstallation(root), trusted)
    git(['update-index', '--assume-unchanged', 'source.txt'])
    writeFileSync(join(root, 'source.txt'), 'hidden modification')
    assert.throws(() => assertTrustedReviewInstallation(root, trusted), /TRUSTED_REVIEW_INDEX_FLAGS_UNSAFE/)
    git(['update-index', '--no-assume-unchanged', 'source.txt'])
    git(['update-index', '--skip-worktree', 'source.txt'])
    assert.throws(() => assertTrustedReviewInstallation(root, trusted), /TRUSTED_REVIEW_INDEX_FLAGS_UNSAFE/)
    git(['update-index', '--no-skip-worktree', 'source.txt'])
    writeFileSync(join(root, 'source.txt'), 'dirty')
    assert.throws(() => assertTrustedReviewInstallation(root, trusted), /TRUSTED_REVIEW_INSTALLATION_DIRTY/)
    git(['add', 'source.txt'])
    git(['commit', '-qm', 'candidate'])
    assert.throws(() => assertTrustedReviewInstallation(root, trusted), /REVIEW_CONTROLLER_NOT_IN_TRUSTED_BASE/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('protected controller installation must match the exact trusted base commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'trusted-review-exact-base-'))
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  try {
    git(['init', '-q'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'source.txt'), 'old')
    git(['add', 'source.txt'])
    git(['commit', '-qm', 'old controller'])
    const old = git(['rev-parse', 'HEAD'])
    writeFileSync(join(root, 'source.txt'), 'new')
    git(['commit', '-qam', 'trusted base'])
    const base = git(['rev-parse', 'HEAD'])
    git(['checkout', '-q', old])
    assert.throws(() => assertTrustedReviewInstallation(root, base), /REVIEW_CONTROLLER_NOT_EXACT_TRUSTED_BASE/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('candidate module cannot borrow a clean trusted base installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'trusted-review-code-path-'))
  const candidate = mkdtempSync(join(tmpdir(), 'candidate-review-code-path-'))
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  try {
    git(['init', '-q'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    const trustedCode = join(root, 'controller.mjs')
    const candidateCode = join(candidate, 'controller.mjs')
    writeFileSync(trustedCode, 'export const controller = true\n')
    writeFileSync(candidateCode, 'export const controller = true\n')
    git(['add', 'controller.mjs'])
    git(['commit', '-qm', 'trusted'])
    const base = git(['rev-parse', 'HEAD'])
    assert.equal(assertTrustedReviewCodePath(root, base, trustedCode, 'controller.mjs'), base)
    assert.throws(() => assertTrustedReviewCodePath(root, base, candidateCode, 'controller.mjs'), /REVIEW_CONTROLLER_CODE_NOT_BASE_ROOTED/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(candidate, { recursive: true, force: true })
  }
})
