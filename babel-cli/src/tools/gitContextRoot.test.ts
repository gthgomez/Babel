import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeTool } from '../localTools.js'

// Removing explicit context-root propagation must make these identities disagree.
test('Git tool binds concurrent explicit nested roots from an unrelated cwd and preserves diff path filters', async t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-git-root-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repos = ['current-app', 'older-clone'].map(name => {
    const dir = join(root, name); mkdirSync(dir)
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim()
    git(['init', '-q', '-b', name])
    for (const file of ['ui.ts', 'other.ts']) writeFileSync(join(dir, file), `${name} original\n`)
    git(['add', 'ui.ts', 'other.ts'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'])
    for (const file of ['ui.ts', 'other.ts']) writeFileSync(join(dir, file), `${name} changed\n`)
    return { dir, name, head: git(['rev-parse', 'HEAD']) }
  })
  const results = await Promise.all(repos.map(repo => executeTool({ tool: 'git_context', format: 'diff', path: 'ui.ts', output_format: 'json' }, { agentId: 'fixture', runId: 'fixture', babelRoot: root, projectRoot: repo.dir })))
  for (const [i, result] of results.entries()) {
    assert.equal(result.exit_code, 0)
    const data = JSON.parse(result.stdout)
    assert.equal(data.branch, repos[i]!.name)
    assert.ok(data.repositoryRoot, 'repositoryRoot must be present for an in-repo fixture')
    const expectedRoot = realpathSync.native?.(repos[i]!.dir) ?? realpathSync(repos[i]!.dir)
    const actualRoot = realpathSync.native?.(data.repositoryRoot) ?? realpathSync(data.repositoryRoot)
    assert.equal(
      actualRoot.replaceAll('\\', '/').toLowerCase(),
      expectedRoot.replaceAll('\\', '/').toLowerCase(),
    )
    assert.equal(data.head, repos[i]!.head)
    assert.match(data.diff, /ui.ts/)
    assert.doesNotMatch(data.diff, /other.ts/)
  }
})
