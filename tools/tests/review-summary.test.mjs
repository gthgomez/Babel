import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('human review summaries retain the verdict without claiming machine evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-summary-'))
  const output = join(root, 'comment.md')
  try {
    const script = fileURLToPath(new URL('../post-ai-review.ps1', import.meta.url))
    const result = spawnSync('pwsh', ['-NoProfile', '-File', script, '-PR', '1', '-HeadSha', 'a'.repeat(40),
      '-Verdict', 'CHANGES_REQUESTED', '-Reviewer', 'fixture reviewer', '-Summary', 'fixture findings', '-OutputPath', output], {encoding: 'utf8'})
    assert.equal(result.status, 0, result.stderr)
    const body = readFileSync(output, 'utf8')
    assert.match(body, /CHANGES_REQUESTED/)
    assert.ok(!body.includes('babel-controller-'))
    assert.match(body, /human-readable review summary/)
  } finally { rmSync(root, {recursive: true, force: true}) }
})
