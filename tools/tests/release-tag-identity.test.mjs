import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

test('exact annotated tag identity rejects malformed, branch-only, collisions and moved tags', async () => {
  const { resolveReleaseTag } = await import('../resolve-release-tag.mjs')
  const tagObject = 'a'.repeat(40), source = 'b'.repeat(40)
  let branch = null, ref = {ref: 'refs/tags/v1.2.3', object: {type: 'tag', sha: tagObject}}
  const read = endpoint => endpoint.includes('/heads/') ? branch : endpoint.includes('/ref/tags/') ? ref : {object: {type: 'commit', sha: source}}
  const options = {repository: 'test/repo', tag: 'v1.2.3', read}
  assert.deepEqual(resolveReleaseTag(options), {tag: 'v1.2.3', version: '1.2.3', tagObjectSha: tagObject, sourceSha: source})
  for (const tag of ['main', 'v01.2.3', 'v1.2.3\n', 'v1.2.3-rc.1', '../v1.2.3']) assert.throws(() => resolveReleaseTag({...options, tag}))
  branch = {ref: 'refs/heads/v1.2.3', object: {type: 'commit', sha: source}}
  assert.throws(() => resolveReleaseTag(options), /collision/)
  branch = null; ref = null
  assert.throws(() => resolveReleaseTag(options), /not observed/)
  ref = {ref: 'refs/tags/v1.2.3', object: {type: 'commit', sha: source}}
  assert.throws(() => resolveReleaseTag(options), /annotated/)
  ref = {ref: 'refs/tags/v1.2.3', object: {type: 'tag', sha: 'c'.repeat(40)}}
  assert.throws(() => resolveReleaseTag({...options, expectedTagObjectSha: tagObject, expectedSourceSha: source}), /moved/)
  ref.object.sha = tagObject
  assert.throws(() => resolveReleaseTag({...options, expectedTagObjectSha: tagObject, expectedSourceSha: 'c'.repeat(40)}), /moved/)
})
test('portable evidence requires one BUILD record matching the frozen source', async () => {
  const { verifyReleaseBuild } = await import('../resolve-release-tag.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'babel-release-build-'))
  const identity = {sourceSha: 'a'.repeat(40), version: '1.2.3'}
  const metadata = {sourceSha: identity.sourceSha, version: identity.version, signed: false, platform: 'win32-x64', cliArchiveSha256: createHash('sha256').update('fixture').digest('hex')}
  try {
    assert.throws(() => verifyReleaseBuild({directory, identity}), /exactly one/)
    mkdirSync(join(directory, 'bundle'))
    writeFileSync(join(directory, 'bundle/BUILD.json'), JSON.stringify({...metadata, sourceSha: 'b'.repeat(40)}))
    assert.throws(() => verifyReleaseBuild({directory, identity}), /source/)
    writeFileSync(join(directory, 'bundle/BUILD.json'), JSON.stringify(metadata))
    writeFileSync(join(directory, 'bundle.zip'), 'fixture')
    writeFileSync(join(directory, 'cli.tgz'), 'fixture')
    assert.equal(verifyReleaseBuild({directory, identity}).build.sourceSha, identity.sourceSha)
    writeFileSync(join(directory, 'cli.tgz'), 'changed')
    assert.throws(() => verifyReleaseBuild({directory, identity}), /digest/)
    writeFileSync(join(directory, 'cli.tgz'), 'fixture')
    writeFileSync(join(directory, 'BUILD.json'), JSON.stringify(metadata))
    assert.throws(() => verifyReleaseBuild({directory, identity}), /exactly one/)
  } finally { rmSync(directory, {recursive: true, force: true}) }
})
