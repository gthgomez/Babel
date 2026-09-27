import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertTrustedReviewInstallation } from './trustedReviewInstallation.js'

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
