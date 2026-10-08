// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/** Resolve only a non-colliding annotated stable tag, freezing its object and peeled commit. */
export function resolveReleaseTag({ repository, tag, read, expectedTagObjectSha, expectedSourceSha }) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  assert.ok(typeof tag === 'string' && tag.trim() === tag && /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag),
    'Automatic release supports stable vMAJOR.MINOR.PATCH tags; preview policy requires an owner decision')
  const ref = read(`repos/${repository}/git/ref/tags/${tag}`)
  assert.ok(ref && ref.ref === `refs/tags/${tag}`, 'Exact release tag not observed')
  assert.equal(read(`repos/${repository}/git/ref/heads/${tag}`), null, 'Release branch/tag collision')
  assert.equal(ref.object.type, 'tag', 'Release must use an annotated tag')
  const tagObjectSha = ref.object.sha
  assert.match(tagObjectSha, /^[a-f0-9]{40}$/)
  let object = ref.object
  for (let depth = 0; object.type === 'tag'; depth++) {
    assert.ok(depth < 10, 'Tag object chain is too deep')
    const annotated = read(`repos/${repository}/git/tags/${object.sha}`)
    assert.ok(annotated?.object, 'Annotated tag object unavailable')
    object = annotated.object
    assert.match(object.sha, /^[a-f0-9]{40}$/)
  }
  assert.equal(object.type, 'commit', 'Release tag must peel to a commit')
  assert.ok(!expectedTagObjectSha || tagObjectSha === expectedTagObjectSha, 'Release tag moved during qualification')
  assert.ok(!expectedSourceSha || object.sha === expectedSourceSha, 'Release source moved during qualification')
  return { tag, version: tag.slice(1), tagObjectSha, sourceSha: object.sha }
}

function readGitHub(endpoint) {
  const r = spawnSync('gh', ['api', endpoint], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  if (r.status !== 0 || r.error) {
    if (r.status === 1 && /HTTP 404/.test(r.stderr)) return null
    throw new Error('Release identity source unavailable (API diagnostics withheld)')
  }
  return JSON.parse(r.stdout)
}

/** Verify exactly one BUILD record and freeze a path-free release evidence record. */
export function verifyReleaseBuild({ directory, identity }) {
  function find(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = resolve(dir, entry.name)
      return entry.isDirectory() ? find(path) : entry.isFile() && entry.name === 'BUILD.json' ? [path] : []
    })
  }
  const builds = find(directory)
  assert.equal(builds.length, 1, 'Successful portable build must contain exactly one BUILD.json')
  const build = JSON.parse(readFileSync(builds[0], 'utf8'))
  assert.equal(build.sourceSha, identity.sourceSha, 'BUILD source must match the frozen tag commit')
  assert.equal(build.version, identity.version, 'BUILD version must match the exact tag')
  assert.equal(build.signed, false)
  assert.equal(build.platform, 'win32-x64')
  const artifacts = readdirSync(directory).filter(name => /\.(zip|tgz)$/.test(name)).sort().map(name => ({ name,
    sha256: createHash('sha256').update(readFileSync(resolve(directory, name))).digest('hex') }))
  assert.equal(artifacts.filter(file => file.name.endsWith('.zip')).length, 1, 'Portable qualification requires exactly one archive')
  const cli = artifacts.filter(file => file.name.endsWith('.tgz'))
  assert.equal(cli.length, 1, 'Portable qualification requires exactly one CLI archive')
  assert.equal(cli[0].sha256, build.cliArchiveSha256, 'BUILD CLI archive digest must match distributed bytes')
  return { ...identity, artifacts, build }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['repository', 'tag', 'expect-object', 'expect-source', 'build-directory', 'identity-out'].map(key => [key, { type: 'string' }])) })
    const identity = resolveReleaseTag({ repository: values.repository, tag: values.tag, read: readGitHub,
      expectedTagObjectSha: values['expect-object'], expectedSourceSha: values['expect-source'] })
    if (values['build-directory']) {
      const evidence = verifyReleaseBuild({ directory: values['build-directory'], identity })
      Object.assign(evidence, { workflowSha: process.env.RELEASE_WORKFLOW_SHA, runId: process.env.GITHUB_RUN_ID })
      writeFileSync(resolve(values['build-directory'], 'release-evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
    }
    if (values['identity-out']) writeFileSync(values['identity-out'], JSON.stringify(identity, null, 2) + '\n')
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      `tag=${identity.tag}\nversion=${identity.version}\nsource_sha=${identity.sourceSha}\ntag_object_sha=${identity.tagObjectSha}\n`)
    console.log(JSON.stringify(identity))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
